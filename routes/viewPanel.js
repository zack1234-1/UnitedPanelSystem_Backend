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

// Helper function for MySQL transactions
const executeTransaction = async (callback) => {
    const connection = await db.getConnection();
    
    try {
        await connection.beginTransaction();
        const result = await callback(connection);
        await connection.commit();
        return result;
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
};

// ============================================
// PANEL ENDPOINTS
// ============================================

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
            estimated_delivery,
            salesman,
            notes,
            status = 'pending'
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
        
        // Calculate initial balance (set to qty if not provided)
        const initialBalance = balance !== undefined ? parseInt(balance) : (qty ? parseInt(qty) : 0);
        
        // Insert into database with new fields
        const query = `
            INSERT INTO panels 
            (reference_number, job_no, type, panel_thk, joint, 
             surface_front, surface_back, surface_front_thk, surface_back_thk, 
             surface_type, width, length, qty, cutting, 
             balance, production_meter, brand, estimated_delivery, 
             salesman, notes, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            initialBalance,
            production_meter ? parseFloat(production_meter) : null,
            brand || null,
            estimated_delivery || null,
            salesman || null,
            notes || null,
            status
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

// POST /api/panels/:id/duplicate - Duplicate a panel
router.post('/:id/duplicate', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Get the panel to duplicate
        const [panel] = await db.execute('SELECT * FROM panels WHERE id = ?', [id]);
        
        if (panel.length === 0) {
            return res.status(404).json({ error: 'Panel not found' });
        }
        
        const panelData = panel[0];
        
        // Generate new reference number
        const referenceNumber = await generateReferenceNumber();
        
        // Prepare new panel data
        const newPanelData = {
            ...panelData,
            reference_number: referenceNumber,
            job_no: `${panelData.job_no}`,
            status: 'pending',
            balance: panelData.qty || 0,
            notes: null
        };
        
        // Remove id and timestamps
        delete newPanelData.id;
        delete newPanelData.created_at;
        delete newPanelData.updated_at;
        
        // DEBUG: Log the original estimated_delivery value
        console.log('Original estimated_delivery:', panelData.estimated_delivery);
        console.log('Type of estimated_delivery:', typeof panelData.estimated_delivery);
        
        // Fix: Convert estimated_delivery to proper MySQL date format
        let formattedEstimatedDelivery = null;
        if (newPanelData.estimated_delivery) {
            console.log('Processing estimated_delivery:', newPanelData.estimated_delivery);
            
            try {
                // First, check if it's already in YYYY-MM-DD format
                if (typeof newPanelData.estimated_delivery === 'string' && 
                    newPanelData.estimated_delivery.match(/^\d{4}-\d{2}-\d{2}$/)) {
                    formattedEstimatedDelivery = newPanelData.estimated_delivery;
                    console.log('Already in YYYY-MM-DD format:', formattedEstimatedDelivery);
                } else {
                    // Parse the date
                    const date = new Date(newPanelData.estimated_delivery);
                    
                    // Check if it's a valid date
                    if (isNaN(date.getTime())) {
                        console.log('Invalid date, setting to null');
                        formattedEstimatedDelivery = null;
                    } else {
                        // Format to YYYY-MM-DD
                        const year = date.getFullYear();
                        const month = String(date.getMonth() + 1).padStart(2, '0');
                        const day = String(date.getDate()).padStart(2, '0');
                        formattedEstimatedDelivery = `${year}-${month}-${day}`;
                        console.log('Formatted date:', formattedEstimatedDelivery);
                    }
                }
            } catch (dateError) {
                console.error('Error parsing date:', dateError);
                formattedEstimatedDelivery = null;
            }
        } else {
            console.log('No estimated_delivery provided, using null');
        }
        
        // DEBUG: Log the values being inserted
        console.log('Values to insert:');
        console.log('- reference_number:', newPanelData.reference_number);
        console.log('- job_no:', newPanelData.job_no);
        console.log('- type:', newPanelData.type);
        console.log('- panel_thk:', newPanelData.panel_thk);
        console.log('- joint:', newPanelData.joint);
        console.log('- estimated_delivery (formatted):', formattedEstimatedDelivery);
        console.log('- salesman:', newPanelData.salesman);
        
        // Insert duplicate panel
        const [result] = await db.execute(
            `INSERT INTO panels 
            (reference_number, job_no, type, panel_thk, joint, 
             surface_front, surface_back, surface_front_thk, surface_back_thk, 
             surface_type, width, length, qty, cutting, 
             balance, production_meter, brand, estimated_delivery, 
             salesman, notes, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                newPanelData.reference_number,
                newPanelData.job_no,
                newPanelData.type,
                newPanelData.panel_thk,
                newPanelData.joint,
                newPanelData.surface_front,
                newPanelData.surface_back,
                newPanelData.surface_front_thk,
                newPanelData.surface_back_thk,
                newPanelData.surface_type,
                newPanelData.width,
                newPanelData.length,
                newPanelData.qty,
                newPanelData.cutting,
                newPanelData.balance,
                newPanelData.production_meter,
                newPanelData.brand,
                formattedEstimatedDelivery, // Use formatted date
                newPanelData.salesman,
                newPanelData.notes,
                newPanelData.status
            ]
        );
        
        // Get the created panel
        const [newPanel] = await db.execute(
            'SELECT * FROM panels WHERE id = ?',
            [result.insertId]
        );
        
        res.status(201).json(newPanel[0]);
        
    } catch (error) {
        console.error('Error duplicating panel:', error);
        console.error('SQL Error details:', {
            code: error.code,
            errno: error.errno,
            sqlState: error.sqlState,
            sqlMessage: error.sqlMessage
        });
        
        res.status(500).json({ 
            error: 'Failed to duplicate panel',
            details: error.message,
            sqlMessage: error.sqlMessage
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
        
        // If qty is being updated, recalculate balance based on production records
        if (updateFields.qty !== undefined) {
            // Get current production records total
            const [productionRecords] = await db.execute(
                'SELECT SUM(number_of_panels) as total_produced FROM production_records WHERE panel_id = ?',
                [id]
            );
            
            const totalProduced = productionRecords[0].total_produced || 0;
            const newQty = parseInt(updateFields.qty) || 0;
            
            // Calculate new balance (qty - total produced)
            const newBalance = Math.max(0, newQty - totalProduced);
            updateFields.balance = newBalance;
        }
        
        // Define allowed fields that can be updated (added salesman and notes)
        const allowedFields = [
            'reference_number', 'job_no', 'type', 'panel_thk', 'joint',
            'surface_front', 'surface_back', 'surface_front_thk', 'surface_back_thk',
            'surface_type', 'width', 'length', 'qty', 'cutting',
            'balance', 'production_meter', 'brand', 'estimated_delivery',
            'salesman', 'notes', 'status'
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
                if (key === 'qty' || key === 'balance') {
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
        
        const result = await executeTransaction(async (connection) => {
            // Delete production records first (foreign key constraint)
            await connection.execute('DELETE FROM production_records WHERE panel_id = ?', [id]);
            
            // Delete panel
            const [deleteResult] = await connection.execute('DELETE FROM panels WHERE id = ?', [id]);
            
            if (deleteResult.affectedRows === 0) {
                throw new Error('Panel not found');
            }
            
            return { message: 'Panel deleted successfully' };
        });
        
        res.json(result);
        
    } catch (error) {
        console.error('Error deleting panel:', error);
        if (error.message === 'Panel not found') {
            return res.status(404).json({ error: 'Panel not found' });
        }
        res.status(500).json({ 
            error: 'Failed to delete panel',
            details: error.message 
        });
    }
});

// ============================================
// PRODUCTION RECORDS ENDPOINTS
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
            notes,
            delivery_date,
            reference_number
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
            'SELECT id, job_no, brand, estimated_delivery FROM panels WHERE id = ?',
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
             date, delivery_date, number_of_panels, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        
        const [result] = await db.execute(query, [
            panelId,
            reference_number || null,
            panelData.job_no || null,
            panelData.brand || null,
            panelData.estimated_delivery || null,
            date,
            delivery_date || date,
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

// POST /api/panels/:panelId/production-with-balance - Create production record with balance update
router.post('/:panelId/production-with-balance', async (req, res) => {
    try {
        const { panelId } = req.params;
        const {
            date,
            number_of_panels,
            notes,
            delivery_date,
            reference_number
        } = req.body;
        
        // Validate required fields
        if (!date) {
            return res.status(400).json({ error: 'Date is required' });
        }
        
        if (!number_of_panels || number_of_panels < 1) {
            return res.status(400).json({ error: 'Number of panels must be at least 1' });
        }
        
        const panelsToProduce = parseInt(number_of_panels);
        
        const result = await executeTransaction(async (connection) => {
            // Check if panel exists and get current balance
            const [panel] = await connection.execute(
                'SELECT id, balance, qty, job_no, brand, estimated_delivery, reference_number FROM panels WHERE id = ?',
                [panelId]
            );
            
            if (panel.length === 0) {
                throw new Error('Panel not found');
            }
            
            const panelData = panel[0];
            const currentBalance = panelData.balance || panelData.qty || 0;
            
            // Check if enough balance is available
            if (panelsToProduce > currentBalance) {
                throw new Error(`Cannot produce ${panelsToProduce} panels. Only ${currentBalance} available.`);
            }
            
            // Calculate new balance
            const newBalance = currentBalance - panelsToProduce;
            
            // Update panel balance
            await connection.execute(
                'UPDATE panels SET balance = ?, updated_at = NOW() WHERE id = ?',
                [newBalance, panelId]
            );
            
            // Insert production record with balance_after field
            const query = `
                INSERT INTO production_records 
                (panel_id, reference_number, job_no, brand, estimated_delivery, 
                 date, delivery_date, number_of_panels, notes, balance_after)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `;
            
            const [insertResult] = await connection.execute(query, [
                panelId,
                reference_number || panelData.reference_number,
                panelData.job_no || null,
                panelData.brand || null,
                panelData.estimated_delivery || null,
                date,
                delivery_date || date,
                panelsToProduce,
                notes || null,
                newBalance
            ]);
            
            // Get the created record
            const [record] = await connection.execute(
                'SELECT * FROM production_records WHERE id = ?',
                [insertResult.insertId]
            );
            
            return {
                production_record: record[0],
                updated_balance: newBalance
            };
        });
        
        res.status(201).json(result);
        
    } catch (error) {
        console.error('Error creating production record with balance update:', error);
        if (error.message.includes('Cannot produce')) {
            return res.status(400).json({ error: error.message });
        }
        if (error.message === 'Panel not found') {
            return res.status(404).json({ error: 'Panel not found' });
        }
        res.status(500).json({ 
            error: 'Failed to create production record',
            details: error.message 
        });
    }
});

// PATCH /api/panels/production-records/:id/status - Update production record status
router.patch('/production-records/:id/status', async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        
        if (!status) {
            return res.status(400).json({ error: 'Status is required' });
        }
        
        // Allowed status values
        const allowedStatuses = ['pending', 'in_progress', 'completed', 'cancelled', 'on_hold'];
        if (!allowedStatuses.includes(status)) {
            return res.status(400).json({ error: 'Invalid status value' });
        }
        
        const [result] = await db.execute(
            'UPDATE production_records SET status = ?, updated_at = NOW() WHERE id = ?',
            [status, id]
        );
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Production record not found' });
        }
        
        const [updatedRecord] = await db.execute(
            'SELECT * FROM production_records WHERE id = ?',
            [id]
        );
        
        res.json(updatedRecord[0]);
        
    } catch (error) {
        console.error('Error updating production record status:', error);
        res.status(500).json({ 
            error: 'Failed to update production record status',
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
        
        const allowedFields = ['date', 'number_of_panels', 'notes', 'delivery_date'];
        
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
        
        const result = await executeTransaction(async (connection) => {
            // Check if panel exists
            const [panel] = await connection.execute(
                'SELECT id, balance FROM panels WHERE id = ?',
                [panelId]
            );
            
            if (panel.length === 0) {
                throw new Error('Panel not found');
            }
            
            // Get production record to delete
            const [record] = await connection.execute(
                'SELECT * FROM production_records WHERE id = ? AND panel_id = ?',
                [recordId, panelId]
            );
            
            if (record.length === 0) {
                throw new Error('Production record not found');
            }
            
            const recordData = record[0];
            const panelsToRestore = recordData.number_of_panels || 0;
            const currentBalance = panel[0].balance || 0;
            
            // Calculate new balance
            const newBalance = currentBalance + panelsToRestore;
            
            // Update panel balance
            await connection.execute(
                'UPDATE panels SET balance = ?, updated_at = NOW() WHERE id = ?',
                [newBalance, panelId]
            );
            
            // Delete production record
            await connection.execute(
                'DELETE FROM production_records WHERE id = ? AND panel_id = ?',
                [recordId, panelId]
            );
            
            return {
                success: true,
                restored_panels: panelsToRestore,
                updated_balance: newBalance,
                message: 'Production record deleted and balance restored'
            };
        });
        
        res.json(result);
        
    } catch (error) {
        console.error('Error deleting production record:', error);
        if (error.message === 'Panel not found' || error.message === 'Production record not found') {
            return res.status(404).json({ error: error.message });
        }
        res.status(500).json({ 
            error: 'Failed to delete production record',
            details: error.message 
        });
    }
});

// DELETE /api/panels/:panelId/production/:recordId/with-balance - Delete production record and restore balance
router.delete('/:panelId/production/:recordId/with-balance', async (req, res) => {
    try {
        const { panelId, recordId } = req.params;
        
        const result = await executeTransaction(async (connection) => {
            // Check if panel exists
            const [panel] = await connection.execute(
                'SELECT id, balance FROM panels WHERE id = ?',
                [panelId]
            );
            
            if (panel.length === 0) {
                throw new Error('Panel not found');
            }
            
            // Get production record to delete
            const [record] = await connection.execute(
                'SELECT * FROM production_records WHERE id = ? AND panel_id = ?',
                [recordId, panelId]
            );
            
            if (record.length === 0) {
                throw new Error('Production record not found');
            }
            
            const recordData = record[0];
            const panelsToRestore = recordData.number_of_panels || 0;
            const currentBalance = panel[0].balance || 0;
            
            // Calculate new balance
            const newBalance = currentBalance + panelsToRestore;
            
            // Update panel balance
            await connection.execute(
                'UPDATE panels SET balance = ?, updated_at = NOW() WHERE id = ?',
                [newBalance, panelId]
            );
            
            // Delete production record
            await connection.execute(
                'DELETE FROM production_records WHERE id = ? AND panel_id = ?',
                [recordId, panelId]
            );
            
            return {
                success: true,
                restored_panels: panelsToRestore,
                updated_balance: newBalance,
                message: 'Production record deleted and balance restored'
            };
        });
        
        res.json(result);
        
    } catch (error) {
        console.error('Error deleting production record with balance restoration:', error);
        if (error.message === 'Panel not found' || error.message === 'Production record not found') {
            return res.status(404).json({ error: error.message });
        }
        res.status(500).json({ 
            error: 'Failed to delete production record',
            details: error.message 
        });
    }
});

// ============================================
// BALANCE AND STATISTICS ENDPOINTS
// ============================================

// GET /api/panels/:panelId/production-summary - Get production summary including current balance
router.get('/:panelId/production-summary', async (req, res) => {
    try {
        const { panelId } = req.params;
        
        // Check if panel exists and get details
        const [panel] = await db.execute(
            'SELECT id, qty, balance, production_meter, status FROM panels WHERE id = ?',
            [panelId]
        );
        
        if (panel.length === 0) {
            return res.status(404).json({ error: 'Panel not found' });
        }
        
        const panelData = panel[0];
        
        // Get production records count and total produced
        const [productionStats] = await db.execute(
            'SELECT COUNT(*) as total_records, SUM(number_of_panels) as total_produced FROM production_records WHERE panel_id = ?',
            [panelId]
        );
        
        const stats = productionStats[0];
        const totalProduced = stats.total_produced || 0;
        const panelQty = panelData.qty || 0;
        const currentBalance = panelData.balance || panelQty;
        const progressPercentage = panelQty > 0 ? 
            Math.min((totalProduced / panelQty) * 100, 100) : 0;
        
        res.json({
            panel_id: panelId,
            total_quantity: panelQty,
            total_produced: totalProduced,
            current_balance: currentBalance,
            production_records_count: stats.total_records || 0,
            progress_percentage: progressPercentage,
            production_meter: panelData.production_meter || 0,
            status: panelData.status || 'pending'
        });
        
    } catch (error) {
        console.error('Error fetching production summary:', error);
        res.status(500).json({ 
            error: 'Failed to fetch production summary',
            details: error.message 
        });
    }
});

// PUT /api/panels/:id/balance - Update panel balance directly
router.put('/:id/balance', async (req, res) => {
    try {
        const { id } = req.params;
        const { balance } = req.body;
        
        if (balance === undefined || balance === null) {
            return res.status(400).json({ error: 'Balance is required' });
        }
        
        // Check if panel exists
        const [panel] = await db.execute('SELECT id FROM panels WHERE id = ?', [id]);
        if (panel.length === 0) {
            return res.status(404).json({ error: 'Panel not found' });
        }
        
        await db.execute(
            'UPDATE panels SET balance = ?, updated_at = NOW() WHERE id = ?',
            [parseInt(balance), id]
        );
        
        const [updatedPanel] = await db.execute(
            'SELECT id, balance, qty FROM panels WHERE id = ?',
            [id]
        );
        
        res.json({
            success: true,
            panel_id: id,
            updated_balance: updatedPanel[0].balance,
            total_quantity: updatedPanel[0].qty
        });
        
    } catch (error) {
        console.error('Error updating panel balance:', error);
        res.status(500).json({ 
            error: 'Failed to update panel balance',
            details: error.message 
        });
    }
});

// GET /api/panels/:id/balance-history - Get balance history from production records
router.get('/:id/balance-history', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Check if panel exists
        const [panel] = await db.execute('SELECT id FROM panels WHERE id = ?', [id]);
        if (panel.length === 0) {
            return res.status(404).json({ error: 'Panel not found' });
        }
        
        // Get production records with balance_after field
        const [records] = await db.execute(
            `SELECT pr.*, p.balance as current_balance 
             FROM production_records pr 
             LEFT JOIN panels p ON pr.panel_id = p.id 
             WHERE pr.panel_id = ? 
             ORDER BY pr.date DESC, pr.created_at DESC`,
            [id]
        );
        
        res.json(records);
        
    } catch (error) {
        console.error('Error fetching balance history:', error);
        res.status(500).json({ 
            error: 'Failed to fetch balance history',
            details: error.message 
        });
    }
});

// GET /api/panels/stats/summary - Get overall statistics
router.get('/stats/summary', async (req, res) => {
    try {
        // Get total panels count
        const [totalPanels] = await db.execute('SELECT COUNT(*) as count FROM panels');
        
        // Get total quantity
        const [totalQty] = await db.execute('SELECT SUM(qty) as total FROM panels');
        
        // Get total produced (sum of all production records)
        const [totalProduced] = await db.execute('SELECT SUM(number_of_panels) as total FROM production_records');
        
        // Get total balance
        const [totalBalance] = await db.execute('SELECT SUM(balance) as total FROM panels');
        
        // Get total production meter
        const [totalProductionMeter] = await db.execute('SELECT SUM(production_meter) as total FROM panels');
        
        // Get balance statistics
        const [balanceStats] = await db.execute(`
            SELECT 
                COUNT(CASE WHEN balance > 0 THEN 1 END) as positive,
                COUNT(CASE WHEN balance = 0 THEN 1 END) as zero,
                COUNT(CASE WHEN balance < 0 THEN 1 END) as negative,
                COUNT(CASE WHEN balance <= qty * 0.1 AND balance > 0 THEN 1 END) as low
            FROM panels
        `);
        
        // Get status statistics
        const [statusStats] = await db.execute(`
            SELECT 
                COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending,
                COUNT(CASE WHEN status = 'in_progress' THEN 1 END) as in_progress,
                COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed
            FROM panels
        `);
        
        res.json({
            total_panels: totalPanels[0].count || 0,
            total_quantity: totalQty[0].total || 0,
            total_produced: totalProduced[0].total || 0,
            total_balance: totalBalance[0].total || 0,
            total_production_meter: totalProductionMeter[0].total || 0,
            balance_statistics: balanceStats[0],
            status_statistics: statusStats[0]
        });
        
    } catch (error) {
        console.error('Error fetching statistics:', error);
        res.status(500).json({ 
            error: 'Failed to fetch statistics',
            details: error.message 
        });
    }
});

module.exports = router;