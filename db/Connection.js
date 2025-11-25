// db/connection.js

// Load environment variables from the .env file
require('dotenv').config();

const mysql = require('mysql2');

// Configure the connection pool using ENV variables
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    
    // Recommended pool settings
    waitForConnections: true,
    connectionLimit: 10,      
    queueLimit: 0             
});

// Export the pool in promise mode for async/await usage
module.exports = pool.promise();