// server.js - Main server file
require('dotenv').config();

const express = require('express');
const cors = require('cors');

// Import routes
const projectRoutes = require('./routes/projectRoutes');
const panelTasksRoutes = require('./routes/panelTasks');
const doorTasksRouter = require('./routes/doorTasks');
const accessoriesTasksRouter = require('./routes/accessoriesTasks');
const cuttingTasksRouter = require('./routes/cuttingTasks');
const stripCurtainTasksRouter = require('./routes/stripCurtainTasksRouter');
const systemTasksRouter = require('./routes/systemTasksRouter');
const adminProjectRoutes = require('./routes/adminProjectRoutes');
const activityLogsRouter = require('./routes/activityLogsRouter');
const subTasksRouter = require('./routes/subtasks');
const orderRouter = require('./routes/orders');
const excelDataRouter = require('./routes/excelData');

const app = express();

// Get port from environment or use default
const PORT = process.env.PORT || 8080;

// CORS Configuration
app.use(cors({
    origin: process.env.ALLOWED_ORIGINS 
        ? process.env.ALLOWED_ORIGINS.split(',') 
        : ['http://localhost:3000'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Body parsers
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging middleware
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
    next();
});

// Health check endpoint (required by Render)
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        service: 'project-backend',
        environment: process.env.NODE_ENV || 'development'
    });
});

// Root endpoint
app.get('/', (req, res) => {
    res.json({ 
        message: 'Project Tracker API',
        version: '1.0.0',
        endpoints: {
            projects: '/api/projects',
            health: '/health',
            panelTasks: '/api/panel-tasks',
            doorTasks: '/api/door-tasks',
            accessoriesTasks: '/api/accessories-tasks',
            cuttingTasks: '/api/cutting-tasks',
            stripCurtainTasks: '/api/strip-curtain-tasks',
            systemTasks: '/api/system-tasks',
            activityLogs: '/api/activity-logs',
            subtasks: '/api/subtasks',
            orders: '/api/orders'
        }
    });
});

// API Routes
app.use('/api/projects', projectRoutes);
app.use('/api/panel-tasks', panelTasksRoutes);
app.use('/api/door-tasks', doorTasksRouter);
app.use('/api/accessories-tasks', accessoriesTasksRouter);
app.use('/api/cutting-tasks', cuttingTasksRouter);
app.use('/api/strip-curtain-tasks', stripCurtainTasksRouter);
app.use('/api/system-tasks', systemTasksRouter);
app.use('/api/admin/projects', adminProjectRoutes);
app.use('/api/activity-logs', activityLogsRouter);
app.use('/api/subtasks', subTasksRouter);
app.use('/api/orders', orderRouter);
app.use('/api', excelDataRouter);

// 404 handler
app.use('*', (req, res) => {
    res.status(404).json({
        error: 'Not Found',
        message: `Cannot ${req.method} ${req.originalUrl}`
    });
});

// Global error handler
app.use((err, req, res, next) => {
    console.error('Error:', err.stack);
    
    const statusCode = err.status || 500;
    const message = err.message || 'Internal Server Error';
    
    res.status(statusCode).json({
        error: message,
        timestamp: new Date().toISOString(),
        path: req.path
    });
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    // Don't exit in production, let the process manager restart if needed
    if (process.env.NODE_ENV === 'production') {
        process.exit(1);
    }
});

// Start server
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`
===========================================
🚀 Server running on port: ${PORT}
📁 Environment: ${process.env.NODE_ENV || 'development'}
⏰ Started at: ${new Date().toISOString()}
===========================================
    `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

module.exports = server;