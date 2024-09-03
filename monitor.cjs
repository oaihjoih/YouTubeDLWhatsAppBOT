const { spawn } = require('child_process');
const path = require('path');

// Path to the script you want to monitor
const scriptPath = path.join(__dirname, 'index.js');

// Function to start the script
function startScript() {
    console.log('Starting index.js script...');

    const child = spawn('node', [scriptPath], {
        stdio: 'inherit', // Inherit stdio so you can see the output in the console
    });

    // Listen for script exit
    child.on('exit', (code, signal) => {
        if (signal) {
            console.log(`index.js was killed with signal: ${signal}`);
        } else if (code !== 0) {
            console.log(`index.js exited with code: ${code}. Restarting...`);
            startScript(); // Restart the script if it crashes
        } else {
            console.log('index.js exited gracefully.');
        }
    });

    // Listen for errors in spawning the child process
    child.on('error', (err) => {
        console.error('Failed to start child process:', err);
        // You can add a delay before restarting if desired
        setTimeout(startScript, 5000); // Restart the script after 5 seconds if an error occurs
    });
}

// Start the monitoring process
startScript();
