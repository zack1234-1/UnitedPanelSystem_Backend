// db/connection.js

// Load environment variables from the .env file
require('dotenv').config();

const mysql = require('mysql2');

// Configure the connection pool using ENV variables
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'project_tracker',
    port: process.env.DB_PORT || 3306,
    
    // Recommended pool settings
    waitForConnections: true,
    connectionLimit: 10,       
    queueLimit: 0              
});

// Test the connection when the application starts
pool.getConnection((err, connection) => {
    if (err) {
        console.error('❌ Database connection failed:', err.message);
        console.log('Please check:');
        console.log('1. Is MySQL server running?');
        console.log('2. Are database credentials correct?');
        console.log('3. Does the database exist?');
    } else {
        console.log('✅ Connected to database as id ' + connection.threadId);
        connection.release(); // Release the connection back to the pool
    }
});

// Export the pool in promise mode for async/await usage
// This is the object you will import as 'pool' in your routes
module.exports = pool.promise();