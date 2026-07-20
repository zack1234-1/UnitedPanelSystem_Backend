require('dotenv').config();

const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

// ---------- Routes (optional modules) ----------
let projectRoutes, panelTasksRoutes, doorTasksRouter, accessoriesTasksRouter, cuttingTasksRouter;
let stripCurtainTasksRouter, systemTasksRouter, adminProjectRoutes, activityLogsRouter;
let subTasksRouter, orderRouter, excelDataRouter, panelsRouter;
let transportationTasksRouter, stockRoutes, inventoryRouter, aiRouter;

function loadModule(modulePath, fallbackName) {
    try {
        return require(modulePath);
    } catch (error) {
        console.warn(`⚠️ Could not load ${fallbackName || modulePath}:`, error.message);
        const router = require('express').Router();
        router.get('/', (req, res) => res.json({ message: `${fallbackName || 'Module'} not configured`, status: 'module_not_found' }));
        return router;
    }
}

projectRoutes = loadModule('./routes/projects', 'projectRoutes');
panelTasksRoutes = loadModule('./routes/panelTasks', 'panelTasks');
doorTasksRouter = loadModule('./routes/doorTasks', 'doorTasks');
accessoriesTasksRouter = loadModule('./routes/accessoriesTasks', 'accessoriesTasks');
cuttingTasksRouter = loadModule('./routes/cuttingTasks', 'cuttingTasks');
stripCurtainTasksRouter = loadModule('./routes/stripCurtainTasksRouter', 'stripCurtainTasks');
systemTasksRouter = loadModule('./routes/systemTasksRouter', 'systemTasks');
adminProjectRoutes = loadModule('./routes/adminProjectRoutes', 'adminProjects');
activityLogsRouter = loadModule('./routes/activityLogsRouter', 'activityLogs');
subTasksRouter = loadModule('./routes/subtasks', 'subtasks');
orderRouter = loadModule('./routes/orders', 'orders');
excelDataRouter = loadModule('./routes/excelData', 'excelData');
panelsRouter = loadModule('./routes/viewPanel', 'panels');
transportationTasksRouter = loadModule('./routes/transportationTasks', 'transportationTasks');
stockRoutes = loadModule('./routes/stock', 'stock');

// Inventory router with fallback
const inventoryFileCandidates = ['./routes/doorInventory', './routes/inventory'];
for (const filePath of inventoryFileCandidates) {
    const fullPath = path.join(__dirname, filePath + '.js');
    if (fs.existsSync(fullPath)) {
        try {
            inventoryRouter = require(filePath);
            console.log(`✅ Inventory router loaded from ${filePath}.js`);
            break;
        } catch (err) {
            console.error(`❌ Failed to load ${filePath}.js:`, err.message);
        }
    }
}
if (!inventoryRouter) {
    console.error('❌ No inventory router found. Mounting dummy router.');
    inventoryRouter = express.Router();
    inventoryRouter.all('*', (req, res) => {
        res.status(503).json({ error: 'Inventory service unavailable' });
    });
}

// AI router
aiRouter = require('./routes/aiRouter');

// ---------- Auth & Middleware ----------
const authRoutes = require('./routes/authRoutes');
const authMiddleware = require('./middleware/auth');

// ---------- Express app ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: process.env.NODE_ENV === 'production' 
            ? (process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : [])
            : '*',
        methods: ['GET', 'POST'],
        credentials: true
    }
});

const PORT = process.env.PORT || 5000;

// CORS
app.use(cors({
    origin: process.env.NODE_ENV === 'production' ? (process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : []) : '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']
}));

// ---------- Body parsers ----------
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ---------- 🛡️ JSON Parse Error Handler (added) ----------
app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        console.error('❌ Invalid JSON payload:', err.message);
        return res.status(400).json({ error: 'Invalid JSON payload' });
    }
    next(err);
});

// ---------- File download endpoint ----------
app.get('/api/files/download/:id', async (req, res) => {
    const fileId = req.params.id;
    try {
        const db = require('./db/connection');
        const [rows] = await db.query(
            'SELECT file_name, mime_type, file_data FROM project_files WHERE id = ?',
            [fileId]
        );
        if (rows.length === 0) return res.status(404).send('File not found');
        const file = rows[0];
        res.setHeader('Content-Disposition', `attachment; filename="${file.file_name}"`);
        res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
        res.send(file.file_data);
    } catch (error) {
        console.error('Download error:', error);
        res.status(500).send('Server error');
    }
});

// ---------- Logging ----------
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
    next();
});

// ---------- Health & Root ----------
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'OK', timestamp: new Date().toISOString(), service: 'project-backend', port: PORT });
});
app.get('/', (req, res) => {
    res.json({ message: 'Project Tracker API', version: '1.0.0', websocket: '/socket.io' });
});

// ---------- Mount Auth routes (PUBLIC) ----------
app.use('/api/auth', authRoutes);

// ---------- Mount REST routes ----------
// (All routes are mounted without auth middleware for now; you can add authMiddleware as needed)
app.use('/api/projects', projectRoutes);
app.use('/api/panels', panelsRouter);
app.use('/api/panel-tasks', panelTasksRoutes);
app.use('/api/door-tasks', doorTasksRouter);
app.use('/api/accessories-tasks', accessoriesTasksRouter);
app.use('/api/cutting-tasks', cuttingTasksRouter);
app.use('/api/strip-curtain-tasks', stripCurtainTasksRouter);
app.use('/api/system-tasks', systemTasksRouter);
app.use('/api/transportation-tasks', transportationTasksRouter);
app.use('/api/stock', stockRoutes);
app.use('/api/inventory', inventoryRouter);
app.use('/api/admin/projects', adminProjectRoutes);
app.use('/api/activity-logs', activityLogsRouter);
app.use('/api/subtasks', subTasksRouter);
app.use('/api/orders', orderRouter);
app.use('/api', excelDataRouter);
app.use('/api/ai', aiRouter);

// ---------- Socket.IO ----------
io.on('connection', (socket) => {
    console.log('🟢 Socket.IO client connected:', socket.id);
    socket.on('disconnect', () => {
        console.log('🔴 Socket.IO client disconnected:', socket.id);
    });
});

// ---------- 404 & error handlers ----------
app.use((req, res) => {
    res.status(404).json({ error: 'Not Found', message: `Cannot ${req.method} ${req.originalUrl}` });
});
app.use((err, req, res, next) => {
    console.error('Server Error:', err.stack || err.message);
    res.status(500).json({ error: err.message || 'Internal Server Error' });
});

// ---------- Start server ----------
server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n===========================================`);
    console.log(`🚀 Server running on port: ${PORT}`);
    console.log(`🔌 WebSocket enabled (non-AI)`);
    console.log(`🤖 AI chat endpoint: POST /api/ai/chat`);
    console.log(`🔐 Auth endpoints: /api/auth/register & /api/auth/login`);
    console.log(`📦 Inventory API: /api/inventory`);
    console.log(`📁 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`===========================================\n`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
module.exports = server;