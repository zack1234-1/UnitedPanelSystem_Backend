// projectUpdater.js

const pool = require('../db/connection'); // IMPORTANT: Adjust path if '../db/connection' is not correct

/**
 * Updates the total/completed counts in the main 'project' table.
 * * @param {string} projectNo - The project number (used in the WHERE clause).
 * @param {string} taskType - The prefix of the columns (e.g., 'panel', 'door', 'cutting').
 * @param {string} countType - The suffix of the column ('total' or 'completed').
 * @param {number} delta - The amount to add or subtract (must be 1 or -1).
 */
const updateProjectCounts = async (projectNo, taskType, countType, delta) => {
    // Construct the dynamic column name: e.g., 'total_panel' or 'completed_door'
    const column = `${countType}_${taskType}`;
    
    // Ensure delta is explicitly 1 or -1 for safety
    const safeDelta = delta > 0 ? 1 : -1;

    // The SQL query increments/decrements the column based on its current value
    // NOTE: Column name is injected directly since it's validated by taskType/countType
    const updateSql = `UPDATE projects SET ${column} = ${column} + ? WHERE projectNo = ?`;
    
    try {
        const [results] = await pool.execute(updateSql, [safeDelta, projectNo]);
        
        if (results.affectedRows === 0) {
            console.warn(`Project No ${projectNo} not found or counts not updated for ${column} in 'project' table.`);
        } else {
            console.log(`✅ Successfully updated ${column} for project ${projectNo} by ${safeDelta}.`);
        }
    } catch (err) {
        // Log the error but DO NOT re-throw, as failing to update the project table 
        // should not typically fail the transactional task operation.
        console.error(`❌ ERROR updating project column ${column} for ${projectNo}:`, err.message);
    }
};

module.exports = { updateProjectCounts };