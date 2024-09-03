import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import moment from 'moment-timezone';
import colors from 'colors';
import fs from 'fs';
import { createWriteStream } from 'fs';
import WebTorrent from 'webtorrent';
import path from 'path';
import { fileURLToPath } from 'url';
import ffmpeg from 'fluent-ffmpeg';
import crypto from 'crypto';  // For generating random words
import axios from 'axios';
import * as cheerio from 'cheerio';  // Add cheerio for scraping

// Convert __filename and __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize WebTorrent client
const webTorrentClient = new WebTorrent();

// Initialize WhatsApp client
const { Client, LocalAuth, MessageMedia } = pkg;
const whatsappClient = new Client({
    restartOnAuthFail: true,
    puppeteer: {
        headless: true,
        args: [ '--no-sandbox', '--disable-setuid-sandbox' ]
    },
    webVersionCache: {
        type: 'remote',
        remotePath: `https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2407.3.html`,
    },
    authStrategy: new LocalAuth({ clientId: "client" })
});

const config = JSON.parse(fs.readFileSync(path.join(__dirname, './src/config/config.json'), 'utf-8'));

// To keep track of downloads and chunk names
let downloadSessions = {};

whatsappClient.on('qr', (qr) => {
    console.log(`[${moment().tz(config.timezone).format('HH:mm:ss')}] Scan the QR below:`);
    qrcode.generate(qr, { small: true });
});

whatsappClient.on('ready', () => {
    console.clear();
    const consoleText = path.join(__dirname, './src/config/console.txt');
    fs.readFile(consoleText, 'utf-8', (err, data) => {
        if (err) {
            console.log(`[${moment().tz(config.timezone).format('HH:mm:ss')}] Console Text not found!`.yellow);
            console.log(`[${moment().tz(config.timezone).format('HH:mm:ss')}] ${config.name} is Ready!`.green);
        } else {
            console.log(data.green);
            console.log(`[${moment().tz(config.timezone).format('HH:mm:ss')}] ${config.name} is Ready!`.green);
        }
    });
});

async function scrapeMovies() {
    try {
        const response = await axios.get('https://www.torrent9.gl/torrents/films/seeds/desc');
        const $ = cheerio.load(response.data);
        
        const movies = [];
        
        // Select the <tr> elements that contain the movie details
        $('tr').each((index, element) => {
            const titleElement = $(element).find('td a');
            const sizeElement = $(element).find('td[style="font-size:12px"]');

            const title = titleElement.text().trim();
            const href = titleElement.attr('href') ? titleElement.attr('href').trim() : null;
            const size = sizeElement.text().trim();

            if (title && href) {
                movies.push({
                    id: index + 1,
                    title,
                    href: `https://www.torrent9.gl${href}`,
                    size
                });
            }
        });

        return movies;
    } catch (error) {
        console.error('Error scraping movies:', error);
        return [];
    }
}


async function scrapeMagnetUrl(movieUrl) {
    try {
        const response = await axios.get(movieUrl);
        const $ = cheerio.load(response.data);
        const magnetLink = $('a[href^="magnet:"]').attr('href');
        return magnetLink || 'Magnet link not found';
    } catch (error) {
        console.error('Error scraping magnet URL:', error);
        return 'Error retrieving magnet link';
    }
}

async function getMoviesAndSendOptions(message) {
    const movies = await scrapeMovies();
    
    if (movies.length === 0) {
        whatsappClient.sendMessage(message.from, 'No movies found.');
        return;
    }

    let movieList = 'Movies found:\n';
    movies.forEach(movie => {
        movieList += `${movie.id}. ${movie.title} - ${movie.size}\n`;
    });
    whatsappClient.sendMessage(message.from, movieList);

    const movieId = parseInt(await askQuestion(message.from, 'Enter the ID of the movie to find the magnet URL: '), 10);
    
    const selectedMovie = movies.find(movie => movie.id === movieId);
    
    if (selectedMovie) {
        const magnetUrl = await scrapeMagnetUrl(selectedMovie.href);
        whatsappClient.sendMessage(message.from, `Magnet URL for ${selectedMovie.title} (${selectedMovie.size}): ${magnetUrl}`);
    } else {
        whatsappClient.sendMessage(message.from, 'Invalid ID. Please try again.');
    }
}


function askQuestion(user, question) {
    return new Promise(resolve => {
        whatsappClient.sendMessage(user, question);
        whatsappClient.on('message', function listener(message) {
            if (message.from === user) {
                whatsappClient.off('message', listener);
                resolve(message.body);
            }
        });
    });
}

whatsappClient.on('message', async (message) => {
    let messageBody = message.body.trim(); // Trim the message body to remove any extra spaces
    let isGroups = message.from.endsWith('@g.us') ? true : false;

    // Generate a random word for unique naming
    function generateRandomWord() {
        return crypto.randomBytes(3).toString('hex');
    }

    async function chunkVideo(filePath, uniqueName, chunkDuration = 300) {
        console.log('Starting video chunking for:', filePath);
    
        return new Promise((resolve, reject) => {
            const outputTemplate = path.join(__dirname, `./src/database/${uniqueName}-segment-%03d.mp4`); // Always save chunks as MP4
            
            ffmpeg(filePath)
                .outputOptions([
                    '-c copy', // Keep original codec
                    '-map 0', // Map all streams
                    `-f segment`,
                    `-segment_time ${chunkDuration}`,
                    `-reset_timestamps 1`,
                    `-segment_format mp4` // Ensure output format is MP4
                ])
                .on('end', () => {
                    console.log('Chunking finished for:', filePath);
                    fs.unlinkSync(filePath); // Delete the full video file after chunking
                    resolve();
                })
                .on('error', (err) => {
                    console.error('Error chunking video:', err);
                    reject(err);
                })
                .save(outputTemplate);
        });
    }
    
    

    async function downloadTorrent(url) {
        whatsappClient.sendMessage(message.from, '[⏳] Loading..');
        let timeStart = Date.now();
    
        const existingTorrent = webTorrentClient.get(url);
        if (existingTorrent) {
            console.log('Torrent already being downloaded.');
            whatsappClient.sendMessage(message.from, '*[❎]* This torrent is already being downloaded. Please wait.');
            return;
        }
    
        const uniqueName = generateRandomWord();
    
        try {
            webTorrentClient.add(url, { path: path.join(__dirname, './src/database') }, async (torrent) => {
                torrent.on('done', async () => {
                    console.log('Torrent download finished.');
                    const videoFile = torrent.files.find(file => file.name.match(/\.(mp4|mkv|avi|mov|wmv|flv)$/i));
    
                    if (videoFile) {
                        const filePath = path.join(__dirname, './src/database', videoFile.name);
                        console.log(`Processing file: ${filePath}`);
                        
                        await chunkVideo(filePath, uniqueName);
    
                        downloadSessions[message.from] = {
                            uniqueName,
                            totalChunks: 0
                        };
    
                        const chunkFiles = fs.readdirSync(path.join(__dirname, './src/database'))
                            .filter(f => f.startsWith(uniqueName));
                        
                        downloadSessions[message.from].totalChunks = chunkFiles.length;
    
                        let chunkNamesMessage = '*[✅] Video Chunks Created*\n';
                        chunkFiles.forEach((chunk, index) => {
                            chunkNamesMessage += `• ${chunk}\n`;
                        });
    
                        whatsappClient.sendMessage(message.from, chunkNamesMessage);
                    } else {
                        console.error('No video file found in torrent.');
                        whatsappClient.sendMessage(message.from, '*[❎]* No supported video file found in the torrent.');
                    }
                });
            });
        } catch (err) {
            console.error('Error downloading torrent:', err);
            whatsappClient.sendMessage(message.from, '*[❎]* Failed to download torrent!');
        }
    }

    async function sendChunkByName(message, chunkName) {
        const chunkPath = path.join(__dirname, './src/database', chunkName.trim());  // Trim any extra spaces
        console.log(`Checking for chunk at path: ${chunkPath}`);
        if (fs.existsSync(chunkPath)) {
            console.log(`Sending chunk ${chunkName} from path ${chunkPath}`);
            const media = MessageMedia.fromFilePath(chunkPath);
            try {
                await whatsappClient.sendMessage(message.from, media, { sendMediaAsDocument: true });
                console.log(`Chunk ${chunkName} sent successfully.`);
            } catch (err) {
                console.error('Error sending chunk:', err);
                whatsappClient.sendMessage(message.from, '*[❎]* Failed to send chunk!');
            }
        } else {
            console.log(`Chunk ${chunkName} not found.`);
            whatsappClient.sendMessage(message.from, '*[❎]* Chunk not found!');
        }
    }

    if (messageBody.startsWith('!download')) {
        if (!isGroups) {
            let torrentUrl = messageBody.split(' ')[1];
            if (!torrentUrl) {
                whatsappClient.sendMessage(message.from, 'Please provide a torrent magnet link.');
                return;
            }
            await downloadTorrent(torrentUrl);
        } else {
            whatsappClient.sendMessage(message.from, 'This command can only be used in private messages.');
        }
    } else if (messageBody.startsWith('!flush')) {
        if (!isGroups) {
            let uniqueName = messageBody.split(' ')[1];
            if (!uniqueName) {
                whatsappClient.sendMessage(message.from, 'Please provide a unique name to flush chunks.');
                return;
            }
            let chunkFiles = fs.readdirSync(path.join(__dirname, './src/database')).filter(f => f.startsWith(uniqueName));
            chunkFiles.forEach(chunk => {
                fs.unlinkSync(path.join(__dirname, './src/database', chunk));
            });
            whatsappClient.sendMessage(message.from, `Chunks with unique name ${uniqueName} have been deleted.`);
        } else {
            whatsappClient.sendMessage(message.from, 'This command can only be used in private messages.');
        }
    } else if (messageBody.startsWith('!listmovies')) {
        if (!isGroups) {
            await getMoviesAndSendOptions(message);
        } else {
            whatsappClient.sendMessage(message.from, 'This command can only be used in private messages.');
        }
    } else if (messageBody.startsWith('!getchunk')) {
        if (!isGroups) {
            const chunkName = messageBody.split(' ')[1];
            if (!chunkName) {
                whatsappClient.sendMessage(message.from, 'Please provide the name of the chunk to request.');
                return;
            }
            console.log(`Requested chunk name: '${chunkName}'`);
            await sendChunkByName(message, chunkName);
        } else {
            whatsappClient.sendMessage(message.from, 'This command can only be used in private messages.');
        }
    }
});

whatsappClient.initialize();
