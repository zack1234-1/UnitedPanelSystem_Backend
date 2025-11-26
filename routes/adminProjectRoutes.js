const express = require('express');
const router = express.Router();
// Assuming the DB connection path from the original file
const pool = require('../db/connection'); 

// Helper function to format database output into camelCase (or standard frontend naming)
const formatProject = (project) => ({
    jobNo: project.job_no,
    clientName: project.client_name,
    description: project.description,
    status: project.status, // e.g., 'In Progress', 'Completed'
    startDate: project.start_date,
    dueDate: project.due_date,
    createdAt: project.created_at,
    // Add other relevant project fields here (like total_panels, etc., but we won't update them here)
});

// =========================================================
// GET /api/admin/projects - Fetch All Projects
// =========================================================
router.get('/', async (req, res) => {
    // Note: In an admin context, you might fetch more data or use different filtering than the user-facing API.
    const query = 'SELECT * FROM projects ORDER BY created_at DESC';
    try {
        const [results] = await pool.execute(query);
        res.json(results.map(formatProject));
    } catch (err) {
        console.error('Error fetching all projects for admin:', err);
        return res.status(500).json({ error: 'Failed to fetch project list' });
    }
});

// =========================================================
// GET /api/admin/projects/:jobNo - Fetch Single Project
// =========================================================
router.get('/:jobNo', async (req, res) => {
    const jobNo = req.params.jobNo;
    const query = 'SELECT * FROM projects WHERE job_no = ?';
    try {
        const [results] = await pool.execute(query, [jobNo]);
        
        if (results.length === 0) {
            return res.status(404).json({ error: `Project with Job No ${jobNo} not found` });
        }
        
        res.json(formatProject(results[0]));
    } catch (err) {
        console.error(`Error fetching project ${jobNo}:`, err);
        return res.status(500).json({ error: 'Failed to fetch project' });
    }
});


// =========================================================
// POST /api/admin/projects - Create New Project
// =========================================================
router.post('/', async (req, res) => {
    // Expected fields for creation
    const { job_no, client_name, description, status, start_date, due_date } = req.body;
    
    if (!job_no || !client_name) {
        return res.status(400).json({ error: 'Job No and Client Name are required' });
    }

    const insertSql = `
        INSERT INTO projects (job_no, client_name, description, status, start_date, due_date)
        VALUES (?, ?, ?, ?, ?, ?)
    `;
    
    try {
        // Check if project already exists
        const [existing] = await pool.execute('SELECT job_no FROM projects WHERE job_no = ?', [job_no]);
        if (existing.length > 0) {
             return res.status(409).json({ error: `Project with Job No ${job_no} already exists.` });
        }
        
        await pool.execute(insertSql, [
            job_no, 
            client_name, 
            description || null, 
            status || 'Draft', 
            start_date || null, 
            due_date || null
        ]);

        // Fetch and return the newly created project
        const [rows] = await pool.execute('SELECT * FROM projects WHERE job_no = ?', [job_no]);
        
        res.status(201).json(formatProject(rows[0]));
    } catch (err) {
        console.error('Error creating project:', err);
        // Handle potential SQL unique constraint violations (though checked above) or other DB errors
        return res.status(500).json({ error: 'Failed to create project' });
    }
});

// =========================================================
// PUT /api/admin/projects/:jobNo - Update Project
// =========================================================
router.put('/:jobNo', async (req, res) => {
    const jobNo = req.params.jobNo;
    const updates = req.body;
    
    // --- Dynamic UPDATE Query Construction ---
    const allowedFields = ['client_name', 'description', 'status', 'start_date', 'due_date'];
    const fieldsToUpdate = [];
    const updateValues = [];

    for (const field of allowedFields) {
        if (updates[field] !== undefined) {
            fieldsToUpdate.push(`${field} = ?`); 
            // Treat empty strings for optional fields as NULL in the database
            const value = (updates[field] === '') ? null : updates[field];
            updateValues.push(value);
        }
    }

    if (fieldsToUpdate.length === 0) {
        return res.status(400).json({ error: 'No valid fields provided for update.' });
    }

    const setClause = fieldsToUpdate.join(', ');
    const updateSql = `UPDATE projects SET ${setClause} WHERE job_no = ?`;
    const finalBindValues = [...updateValues, jobNo];

    try {
        const [result] = await pool.execute(updateSql, finalBindValues);
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: `Project with Job No ${jobNo} not found.` });
        }
        
        // Fetch and return the updated row
        const [rows] = await pool.execute('SELECT * FROM projects WHERE job_no = ?', [jobNo]);
        
        res.json(formatProject(rows[0]));
    } catch (err) {
        console.error(`Error updating project ${jobNo}:`, err);
        return res.status(500).json({ error: 'Failed to update project' });
    }
});


// =========================================================
// DELETE /api/admin/projects/:jobNo - Delete Project
// =========================================================
router.delete('/:jobNo', async (req, res) => {
    const jobNo = req.params.jobNo;
    
    try {
        // Note: You should typically delete related task entries first in a real application
        // or configure CASCADE ON DELETE constraints in your database schema.
        const [results] = await pool.execute('DELETE FROM projects WHERE job_no = ?', [jobNo]);
        
        if (results.affectedRows === 0) {
            return res.status(404).json({ error: 'Project not found' });
        }
        
        res.status(200).json({ message: `Project ${jobNo} deleted successfully` });
    } catch (err) {
        console.error(`Error deleting project ${jobNo}:`, err);
        return res.status(500).json({ error: 'Failed to delete project' });
    }
});

module.exports = router;