const db = require('../db/connection');
const axios = require('axios');
require('dotenv').config();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const categoryDisplayNames = {
    panel: 'Panel',
    cutting: 'Cutting',
    door: 'Door',
    strip_curtain: 'Strip Curtain',
    accessories: 'Accessories',
    system: 'System',
    transportation: 'Transportation',
    quotation: 'Quotation'
};

const columnMap = {
    panel: { total: 'total_panel', completed: 'completed_panel' },
    cutting: { total: 'total_cutting', completed: 'completed_cutting' },
    door: { total: 'total_door', completed: 'completed_door' },
    strip_curtain: { total: 'total_strip_curtain', completed: 'completed_strip_curtain' },
    accessories: { total: 'total_accessories', completed: 'completed_accessories' },
    system: { total: 'total_system', completed: 'completed_system' },
    transportation: { total: 'total_transportation', completed: 'completed_transportation' },
    quotation: { total: 'total_quotation', completed: 'completed_quotation' }
};

async function sendTelegramNotification(message, title = '📋 Project Update') {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.warn('Telegram credentials missing.');
        return;
    }
    try {
        const fullMessage = `<b>${title}</b>\n\n${message}`;
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: fullMessage,
            parse_mode: 'HTML'
        });
        console.log('✅ Telegram notification sent.');
    } catch (err) {
        console.error('❌ Telegram error:', err.message);
    }
}

async function checkAndNotifyCategoryCompletion(projectId, category) {
    const cols = columnMap[category];
    if (!cols) return;

    // 1. Get project details + category totals
    const [projectRows] = await db.query(
        `SELECT 
            projectNo, customer, status, drawingDate, poPayment, requestedDelivery, salesman, projectName,
            ${cols.total} as total,
            ${cols.completed} as completed
         FROM projects WHERE id = ?`,
        [projectId]
    );
    if (projectRows.length === 0) return;
    const project = projectRows[0];
    const total = project.total || 0;
    const completed = project.completed || 0;
    const allCompleted = total > 0 && total === completed;

    if (!allCompleted) return;

    // 2. Get ALL category summaries
    const [summaryRows] = await db.query(
        `SELECT 
            total_panel, completed_panel,
            total_cutting, completed_cutting,
            total_door, completed_door,
            total_strip_curtain, completed_strip_curtain,
            total_accessories, completed_accessories,
            total_system, completed_system,
            total_transportation, completed_transportation,
            total_quotation, completed_quotation
         FROM projects WHERE id = ?`,
        [projectId]
    );

    let summaryText = '';
    for (const [cat, cols] of Object.entries(columnMap)) {
        const totalCat = summaryRows[0][cols.total] || 0;
        const completedCat = summaryRows[0][cols.completed] || 0;
        if (totalCat === 0) continue;
        const checkmark = totalCat === completedCat ? ' ✅' : '';
        const highlight = cat === category ? ' ⭐' : '';
        summaryText += `${categoryDisplayNames[cat]} task: ${completedCat}/${totalCat}${checkmark}${highlight}\n`;
    }

    // 3. Build full message with project details
    const projectDetails = 
        `📌 <b>Project:</b> ${project.projectNo}\n` +
        `🏷️ <b>Name:</b> ${project.projectName || 'N/A'}\n` +
        `👤 <b>Customer:</b> ${project.customer}\n` +
        `📊 <b>Status:</b> ${project.status || 'N/A'}\n` +
        `📅 <b>Drawing Date:</b> ${project.drawingDate ? new Date(project.drawingDate).toLocaleDateString() : 'N/A'}\n` +
        `📦 <b>PO Payment:</b> ${project.poPayment || 'N/A'}\n` +
        `🚚 <b>Requested Delivery:</b> ${project.requestedDelivery ? new Date(project.requestedDelivery).toLocaleDateString() : 'N/A'}\n` +
        `👔 <b>Salesman:</b> ${project.salesman || 'N/A'}\n\n`;

    const message = 
        projectDetails +
        `📊 <b>Category Completed:</b> ${categoryDisplayNames[category]} (${completed}/${total})\n\n` +
        `<b>Full Task Summary:</b>\n${summaryText}`;

    await sendTelegramNotification(message, `🎉 ${categoryDisplayNames[category]} Complete!`);
}

module.exports = { checkAndNotifyCategoryCompletion };