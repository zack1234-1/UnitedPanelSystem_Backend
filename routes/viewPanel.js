// routes/viewPanel.js - UPDATED VERSION
const express = require('express');
const router = express.Router();
const db = require('../db/connection');

// Helper function to generate reference number
const generateReferenceNumber = async () => {
    const now = new Date();
    const year = now.getFullYear().toString().slice(-2);
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    
    const todayPrefix = `REF-${year}${month}${day}`;
    const [latest] = await db.execute(
        'SELECT reference_number FROM panels WHERE reference_number LIKE ? ORDER BY id DESC LIMIT 1',
        [`${todayPrefix}%`]
    );
    
    let sequence = 1;
    if (latest.length > 0) {
        const ref = latest[0].reference_number;
        const match = ref.match(/\d+$/);
        if (match) {
            sequence = parseInt(match[0]) + 1;
        }
    }
    
    return `${todayPrefix}-${String(sequence).padStart(3, '0')}`;
};

// GET /api/panels - Get all panels
router.get('/', async (req, res) => {
    try {
        const [panels] = await db.execute('SELECT * FROM panels ORDER BY created_at DESC');
        res.json(panels);
    } catch (error) {
        console.error('Error fetching panels:', error);
        res.status(500).json({ 
            error: 'Failed to fetch panels',
            details: error.message 
        });
    }
});

// GET /api/panels/:id - Get single panel by ID
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const [panels] = await db.execute('SELECT * FROM panels WHERE id = ?', [id]);
        
        if (panels.length === 0) {
            return res.status(404).json({ error: 'Panel not found' });
        }
        
        res.json(panels[0]);
    } catch (error) {
        console.error('Error fetching panel:', error);
        res.status(500).json({ 
            error: 'Failed to fetch panel',
            details: error.message 
        });
    }
});

// POST /api/panels - Create a new panel
router.post('/', async (req, res) => {
    try {
        const {
            reference_number,
            job_no,
            type,
            panel_thk,
            joint,
            surface_front,
            surface_back,
            surface_front_thk,
            surface_back_thk,
            surface_type,
            width,
            length,
            qty,
            cutting,
            balance,
            production_meter,
            brand,
            estimated_delivery
        } = req.body;
        
        // Basic validation
        if (!job_no || !width || !length) {
            return res.status(400).json({ 
                error: 'Job No, width, and length are required' 
            });
        }
        
        // Generate reference number if not provided
        let refNumber = reference_number;
        if (!refNumber) {
            refNumber = await generateReferenceNumber();
        }
        
        // Insert into database
        const query = `
            INSERT INTO panels 
            (reference_number, job_no, type, panel_thk, joint, 
             surface_front, surface_back, surface_front_thk, surface_back_thk, 
             surface_type, width, length, qty, cutting, 
             balance, production_meter, brand, estimated_delivery)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        
        const [result] = await db.execute(query, [
            refNumber,
            job_no || null,
            type || null,
            panel_thk ? parseFloat(panel_thk) : null,
            joint || null,
            surface_front || null,
            surface_back || null,
            surface_front_thk ? parseFloat(surface_front_thk) : null,
            surface_back_thk ? parseFloat(surface_back_thk) : null,
            surface_type || null,
            parseFloat(width) || 0,
            parseFloat(length) || 0,
            qty ? parseInt(qty) : null,
            cutting || null,
            balance ? parseFloat(balance) : null,
            production_meter ? parseFloat(production_meter) : null,
            brand || null,
            estimated_delivery || null
        ]);
        
        // Return the created panel
        const [panel] = await db.execute(
            'SELECT * FROM panels WHERE id = ?',
            [result.insertId]
        );
        
        res.status(201).json(panel[0]);
        
    } catch (error) {
        console.error('Error creating panel:', error);
        res.status(500).json({ 
            error: 'Failed to create panel',
            details: error.message 
        });
    }
});

// PUT /api/panels/:id - Update panel
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const updateFields = req.body;
        
        // Validation
        if (!updateFields || Object.keys(updateFields).length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }
        
        if (updateFields.job_no && !updateFields.job_no.trim()) {
            return res.status(400).json({ error: 'Job No is required' });
        }
        
        if ((updateFields.width && parseFloat(updateFields.width) <= 0) || 
            (updateFields.length && parseFloat(updateFields.length) <= 0)) {
            return res.status(400).json({ error: 'Width and length must be positive numbers' });
        }
        
        // Define allowed fields that can be updated
        const allowedFields = [
            'reference_number', 'job_no', 'type', 'panel_thk', 'joint',
            'surface_front', 'surface_back', 'surface_front_thk', 'surface_back_thk',
            'surface_type', 'width', 'length', 'qty', 'cutting',
            'balance', 'production_meter', 'brand', 'estimated_delivery'
        ];
        
        // Build update query dynamically
        const fields = [];
        const values = [];
        
        for (const [key, value] of Object.entries(updateFields)) {
            // Skip if field is not allowed or is id
            if (!allowedFields.includes(key) || key === 'id') continue;
            
            const numericFields = [
                'width', 'length', 'panel_thk', 'surface_front_thk', 
                'surface_back_thk', 'qty', 'balance', 'production_meter'
            ];
            
            if (numericFields.includes(key)) {
                if (key === 'qty') {
                    fields.push(`${key} = ?`);
                    values.push(value ? parseInt(value) : null);
                } else {
                    fields.push(`${key} = ?`);
                    values.push(value ? parseFloat(value) : null);
                }
            } else {
                fields.push(`${key} = ?`);
                values.push(value);
            }
        }
        
        if (fields.length === 0) {
            return res.status(400).json({ error: 'No valid fields to update' });
        }
        
        fields.push('updated_at = NOW()');
        
        const query = `UPDATE panels SET ${fields.join(', ')} WHERE id = ?`;
        values.push(id);
        
        const [result] = await db.execute(query, values);
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Panel not found' });
        }
        
        const [updatedPanel] = await db.execute('SELECT * FROM panels WHERE id = ?', [id]);
        
        res.json(updatedPanel[0]);
        
    } catch (error) {
        console.error('Error updating panel:', error);
        res.status(500).json({ 
            error: 'Failed to update panel',
            details: error.message 
        });
    }
});

// DELETE /api/panels/:id - Delete panel
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        const [result] = await db.execute('DELETE FROM panels WHERE id = ?', [id]);
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Panel not found' });
        }
        
        res.json({ message: 'Panel deleted successfully' });
        
    } catch (error) {
        console.error('Error deleting panel:', error);
        res.status(500).json({ 
            error: 'Failed to delete panel',
            details: error.message 
        });
    }
});

// ============================================
// PRODUCTION RECORDS ENDPOINTS - UPDATED
// ============================================

// GET /api/panels/:panelId/production-records - Get all production records for a panel
router.get('/:panelId/production-records', async (req, res) => {
    try {
        const { panelId } = req.params;
        
        // Check if panel exists
        const [panel] = await db.execute('SELECT id FROM panels WHERE id = ?', [panelId]);
        if (panel.length === 0) {
            return res.status(404).json({ error: 'Panel not found' });
        }
        
        const [records] = await db.execute(
            'SELECT * FROM production_records WHERE panel_id = ? ORDER BY date DESC, created_at DESC',
            [panelId]
        );
        
        res.json(records);
    } catch (error) {
        console.error('Error fetching production records:', error);
        res.status(500).json({ 
            error: 'Failed to fetch production records',
            details: error.message 
        });
    }
});

// POST /api/panels/:panelId/production-records - Create a new production record
router.post('/:panelId/production-records', async (req, res) => {
    try {
        const { panelId } = req.params;
        const {
            date,
            number_of_panels,
            notes
        } = req.body;
        
        // Validate required fields
        if (!date) {
            return res.status(400).json({ error: 'Date is required' });
        }
        
        if (!number_of_panels || number_of_panels < 1) {
            return res.status(400).json({ error: 'Number of panels must be at least 1' });
        }
        
        // Check if panel exists and get panel details
        const [panel] = await db.execute(
            'SELECT id, reference_number, job_no, brand, estimated_delivery FROM panels WHERE id = ?',
            [panelId]
        );
        
        if (panel.length === 0) {
            return res.status(404).json({ error: 'Panel not found' });
        }
        
        const panelData = panel[0];
        
        // Insert production record
        const query = `
            INSERT INTO production_records 
            (panel_id, reference_number, job_no, brand, estimated_delivery, 
             date, number_of_panels, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `;
        
        const [result] = await db.execute(query, [
            panelId,
            panelData.reference_number || null,
            panelData.job_no || null,
            panelData.brand || null,
            panelData.estimated_delivery || null,
            date,
            parseInt(number_of_panels) || 1,
            notes || null
        ]);
        
        // Return the created record
        const [record] = await db.execute(
            'SELECT * FROM production_records WHERE id = ?',
            [result.insertId]
        );
        
        res.status(201).json(record[0]);
        
    } catch (error) {
        console.error('Error creating production record:', error);
        res.status(500).json({ 
            error: 'Failed to create production record',
            details: error.message 
        });
    }
});

// PUT /api/panels/:panelId/production-records/:recordId - Update production record
router.put('/:panelId/production-records/:recordId', async (req, res) => {
    try {
        const { panelId, recordId } = req.params;
        const updateFields = req.body;
        
        // Validation
        if (!updateFields || Object.keys(updateFields).length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }
        
        // Check if panel exists
        const [panel] = await db.execute('SELECT id FROM panels WHERE id = ?', [panelId]);
        if (panel.length === 0) {
            return res.status(404).json({ error: 'Panel not found' });
        }
        
        // Check if record exists and belongs to the panel
        const [existingRecord] = await db.execute(
            'SELECT * FROM production_records WHERE id = ? AND panel_id = ?',
            [recordId, panelId]
        );
        
        if (existingRecord.length === 0) {
            return res.status(404).json({ error: 'Production record not found' });
        }
        
        // Build update query dynamically
        const fields = [];
        const values = [];
        
        const allowedFields = ['date', 'number_of_panels', 'notes'];
        
        for (const [key, value] of Object.entries(updateFields)) {
            if (!allowedFields.includes(key)) continue;
            
            if (key === 'number_of_panels') {
                if (value && value < 1) {
                    return res.status(400).json({ error: 'Number of panels must be at least 1' });
                }
                fields.push(`${key} = ?`);
                values.push(value ? parseInt(value) : null);
            } else {
                fields.push(`${key} = ?`);
                values.push(value);
            }
        }
        
        if (fields.length === 0) {
            return res.status(400).json({ error: 'No valid fields to update' });
        }
        
        fields.push('updated_at = NOW()');
        
        const query = `UPDATE production_records SET ${fields.join(', ')} WHERE id = ? AND panel_id = ?`;
        values.push(recordId, panelId);
        
        const [result] = await db.execute(query, values);
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Production record not found' });
        }
        
        // Get updated record
        const [updatedRecord] = await db.execute(
            'SELECT * FROM production_records WHERE id = ?',
            [recordId]
        );
        
        res.json(updatedRecord[0]);
        
    } catch (error) {
        console.error('Error updating production record:', error);
        res.status(500).json({ 
            error: 'Failed to update production record',
            details: error.message 
        });
    }
});

// DELETE /api/panels/:panelId/production-records/:recordId - Delete production record
router.delete('/:panelId/production-records/:recordId', async (req, res) => {
    try {
        const { panelId, recordId } = req.params;
        
        // Check if panel exists
        const [panel] = await db.execute('SELECT id FROM panels WHERE id = ?', [panelId]);
        if (panel.length === 0) {
            return res.status(404).json({ error: 'Panel not found' });
        }
        
        const [result] = await db.execute(
            'DELETE FROM production_records WHERE id = ? AND panel_id = ?',
            [recordId, panelId]
        );
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Production record not found' });
        }
        
        res.json({ message: 'Production record deleted successfully' });
        
    } catch (error) {
        console.error('Error deleting production record:', error);
        res.status(500).json({ 
            error: 'Failed to delete production record',
            details: error.message 
        });
    }
});

module.exports = router;