// src/routes/cuttingRouter.js
const express = require('express');
const router = express.Router();
// IMPORTANT: Adjust the path to your database connection and activity logging utility
const db = require('../db/connection'); 
const logActivity = require('../utils/activityLogger'); // Assuming a utility file for logging

// =========================================================
// ✂️ CUTTING ROUTES (CRUD)
// =========================================================

/**
 * GET /api/cutting/:projectNo
 * Fetches all cutting details for a specific project number.
 */
router.get('/:projectNo', async (req, res) => {
    const { projectNo } = req.params;

    try {
        const query = `
            SELECT * FROM cutting_details 
            WHERE projectNo = ? 
            ORDER BY created_at DESC
        `;
        const [cuttingDetails] = await db.query(query, [projectNo]);
        
        res.json(cuttingDetails);
    } catch (err) {
        console.error('Database GET Error (Cutting Details):', err);
        res.status(500).json({ 
            error: 'Failed to retrieve cutting details.',
            details: err.message 
        });
    }
});

/**
 * POST /api/cutting
 * Creates a new cutting detail record.
 */
router.post('/', async (req, res) => {
    const { 
        projectNo, project_id, itemDescription, materialType, 
        length, width, quantity, cutBy, cutDate, status, remarks 
    } = req.body;

    if (!projectNo || !itemDescription || !quantity) {
        return res.status(400).json({ error: 'Project No., Item Description, and Quantity are required.' });
    }

    // Ensure the query starts clean by using .trim() if using backticks and multi-line strings
    const query = `
        INSERT INTO cutting_details 
        (projectNo, project_id, item_description, material_type, length, width, quantity, cut_by, cut_date, status, remarks)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `.trim(); 
    
    const values = [
        projectNo, project_id, itemDescription, materialType, 
        length, width, quantity, cutBy, cutDate, status || 'Pending', remarks
    ];

    try {
        const [result] = await db.query(query, values);
        
        // Fetch the newly created record
        const [newRecord] = await db.query('SELECT * FROM cutting_details WHERE id = ?', [result.insertId]);

        // Logging activity (ensure logActivity is available)
        // await logActivity('CREATE', 'CUTTING_DETAIL', result.insertId, `New cutting item created for project ${projectNo}: ${itemDescription}.`);

        res.status(201).json(newRecord[0]); 

    } catch (err) {
        console.error('Database POST Error (Create Cutting Detail):', err);
        res.status(500).json({ 
            error: 'Failed to create new cutting record.',
            details: err.message 
        });
    }
});

/**
 * PUT /api/cutting/:id
 * Updates an existing cutting detail record.
 */
router.put('/:id', async (req, res) => {
    const { id } = req.params;
    const { 
        projectNo, itemDescription, materialType, 
        length, width, quantity, cutBy, cutDate, status, remarks 
    } = req.body;
    
    if (!projectNo || !itemDescription || !quantity) {
        return res.status(400).json({ error: 'Required fields missing for update.' });
    }

    const query = `
        UPDATE cutting_details SET 
        item_description = ?, material_type = ?, length = ?, width = ?, 
        quantity = ?, cut_by = ?, cut_date = ?, status = ?, remarks = ?
        WHERE id = ?
    `.trim(); 
    
    const values = [
        itemDescription, materialType, length, width, 
        quantity, cutBy, cutDate, status, remarks,
        id 
    ];

    try {
        const [result] = await db.query(query, values);
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Cutting detail not found.' });
        }

        const [updatedRecord] = await db.query('SELECT * FROM cutting_details WHERE id = ?', [id]);

        // Logging activity
        // await logActivity('UPDATE', 'CUTTING_DETAIL', id, `Cutting item updated for project ${projectNo}.`);

        res.status(200).json(updatedRecord[0]);

    } catch (err) {
        console.error(`Error updating cutting detail ID ${id}:`, err);
        res.status(500).json({ 
            error: 'Failed to update cutting detail.',
            details: err.message
        });
    }
});

/**
 * DELETE /api/cutting/:id
 * Deletes a single cutting detail record.
 */
router.delete('/:id', async (req, res) => {
    const { id } = req.params; 

    try {
        // Fetch info before deletion for logging
        const [recordInfo] = await db.query('SELECT projectNo, item_description FROM cutting_details WHERE id = ?', [id]);
        
        const [result] = await db.query('DELETE FROM cutting_details WHERE id = ?', [id]);
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Cutting detail record not found.' });
        }
        
        if (recordInfo.length > 0) {
            // Logging activity
            // await logActivity('DELETE', 'CUTTING_DETAIL', id, `Deleted cutting item '${recordInfo[0].item_description}' from project ${recordInfo[0].projectNo}.`);
        }
        
        res.status(204).send(); 

    } catch (err) {
        console.error(`Error deleting cutting detail ID ${id}:`, err);
        res.status(500).json({
            error: 'Failed to delete cutting detail.',
            details: err.message
        });
    }
});

module.exports = router;