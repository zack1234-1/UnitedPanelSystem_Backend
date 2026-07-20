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

// GET /api/panels - Get all panels (includes project_id)
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

// GET /api/panels/:id - Get single panel by ID (includes project_id)
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

// POST /api/panels - Create a new panel (accepts project_id)
router.post('/', async (req, res) => {
    try {
        const {
            project_id,          // now required/expected from frontend
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
            estimated_delivery,
            created_at,
            salesman,
            notes,
            application,
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
        
        // Parse values
        const widthFloat = parseFloat(width) || 0;
        const lengthFloat = parseFloat(length) || 0;
        const qtyInt = qty ? parseInt(qty) : 0;
        const initialBalance = balance !== undefined ? parseInt(balance) : qtyInt;
        const calculatedProductionMeter = (lengthFloat * (qtyInt - initialBalance)) || 0;
        const finalProductionMeter = production_meter !== undefined ? 
            parseFloat(production_meter) : calculatedProductionMeter;
        
        // Format dates
        let formattedEstimatedDelivery = null;
        if (estimated_delivery) {
            try {
                const date = new Date(estimated_delivery);
                if (!isNaN(date.getTime())) {
                    formattedEstimatedDelivery = date.toISOString().split('T')[0];
                }
            } catch (err) {
                console.error('Error formatting estimated_delivery:', err);
            }
        }
        
        let formattedCreatedAt = null;
        if (created_at) {
            try {
                const date = new Date(created_at);
                if (!isNaN(date.getTime())) {
                    formattedCreatedAt = date.toISOString().slice(0, 19).replace('T', ' ');
                }
            } catch (err) {
                console.error('Error formatting created_at:', err);
            }
        }
        
        // FIXED column order: project_id first, then reference_number, etc.
        const query = `
            INSERT INTO panels 
            (project_id, reference_number, job_no, type, panel_thk, joint, 
            surface_front, surface_back, surface_front_thk, surface_back_thk, 
            surface_type, width, length, qty, cutting, 
            balance, production_meter, estimated_delivery, 
            created_at, salesman, notes, application, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        
        const [result] = await db.execute(query, [
            project_id || null,          // ✅ now first value matches column order
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
            widthFloat,
            lengthFloat,
            qtyInt,
            cutting || null,
            initialBalance,
            finalProductionMeter,
            formattedEstimatedDelivery,
            formattedCreatedAt,
            salesman || null,
            notes || null,
            application || null,
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
            details: error.message,
            sqlMessage: error.sqlMessage 
        });
    }
});

// POST /api/panels/:id/duplicate - Duplicate a panel (copies project_id)
router.post('/:id/duplicate', async (req, res) => {
    try {
        const { id } = req.params;

        const [panels] = await db.execute('SELECT * FROM panels WHERE id = ?', [id]);
        if (panels.length === 0) {
            return res.status(404).json({ error: 'Panel not found' });
        }

        const panelData = panels[0];
        const referenceNumber = await generateReferenceNumber();

        let formattedDate = null;
        if (panelData.estimated_delivery) {
            const dateObj = new Date(panelData.estimated_delivery);
            if (!isNaN(dateObj.getTime())) {
                formattedDate = dateObj.toISOString().split('T')[0];
            }
        }

        // ✅ Include project_id in the INSERT
        const sql = `INSERT INTO panels 
            (project_id, reference_number, job_no, type, panel_thk, joint, 
             surface_front, surface_back, surface_front_thk, surface_back_thk, 
             surface_type, width, length, qty, cutting, 
             balance, production_meter, estimated_delivery, 
             salesman, notes, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

        const values = [
            panelData.project_id,        // ✅ copy project_id
            referenceNumber,
            panelData.job_no,
            panelData.type,
            panelData.panel_thk,
            panelData.joint,
            panelData.surface_front,
            panelData.surface_back,
            panelData.surface_front_thk,
            panelData.surface_back_thk,
            panelData.surface_type,
            panelData.width,
            panelData.length,
            panelData.qty,
            panelData.cutting,
            panelData.qty || 0,
            panelData.production_meter,
            formattedDate,
            panelData.salesman,
            null,
            'pending'
        ];

        const [result] = await db.execute(sql, values);
        const [newPanel] = await db.execute('SELECT * FROM panels WHERE id = ?', [result.insertId]);

        res.status(201).json(newPanel[0]);

    } catch (error) {
        console.error('Error duplicating panel:', error);
        res.status(500).json({ 
            error: 'Failed to duplicate panel',
            details: error.message,
            sqlMessage: error.sqlMessage 
        });
    }
});

// PUT /api/panels/:id - Update panel (allows updating project_id)
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const updateFields = req.body;
        
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
        
        let currentPanel = null;
        let needsProductionMeterCalculation = false;
        
        if (updateFields.length !== undefined || updateFields.qty !== undefined || updateFields.balance !== undefined) {
            const [current] = await db.execute('SELECT * FROM panels WHERE id = ?', [id]);
            if (current.length === 0) {
                return res.status(404).json({ error: 'Panel not found' });
            }
            currentPanel = current[0];
            needsProductionMeterCalculation = true;
        }
        
        if (updateFields.qty !== undefined) {
            const [productionRecords] = await db.execute(
                'SELECT SUM(number_of_panels) as total_produced FROM production_records WHERE panel_id = ?',
                [id]
            );
            
            const totalProduced = productionRecords[0].total_produced || 0;
            const newQty = parseInt(updateFields.qty) || 0;
            const newBalance = Math.max(0, newQty - totalProduced);
            updateFields.balance = newBalance;
            
            needsProductionMeterCalculation = true;
            if (!currentPanel) {
                const [current] = await db.execute('SELECT * FROM panels WHERE id = ?', [id]);
                currentPanel = current[0];
            }
        }
        
        if (needsProductionMeterCalculation && currentPanel) {
            if (updateFields.production_meter === undefined) {
                const newLength = updateFields.length !== undefined ? 
                    parseFloat(updateFields.length) : parseFloat(currentPanel.length);
                const newQty = updateFields.qty !== undefined ? 
                    parseInt(updateFields.qty) : parseInt(currentPanel.qty);
                const newBalance = updateFields.balance !== undefined ? 
                    parseInt(updateFields.balance) : parseInt(currentPanel.balance);
                
                const calculatedProductionMeter = newLength * (newQty - newBalance);
                updateFields.production_meter = Math.max(0, calculatedProductionMeter);
            }
        }
        
        // Allowed fields now includes project_id
        const allowedFields = [
            'project_id', 'reference_number', 'job_no', 'type', 'panel_thk', 'joint',
            'surface_front', 'surface_back', 'surface_front_thk', 'surface_back_thk',
            'surface_type', 'width', 'length', 'qty', 'cutting',
            'balance', 'production_meter', 'estimated_delivery', 'brand',
            'salesman', 'notes', 'status', 'application', 'created_at',
            'remaining_meter'
        ];
        
        const dateFields = ['created_at', 'estimated_delivery'];
        const fields = [];
        const values = [];
        
        for (const [key, value] of Object.entries(updateFields)) {
            if (!allowedFields.includes(key) || key === 'id') continue;
            
            if (dateFields.includes(key)) {
                if (value) {
                    try {
                        const date = new Date(value);
                        if (isNaN(date.getTime())) {
                            return res.status(400).json({ error: `Invalid date format for ${key}` });
                        }
                        const mysqlDatetime = date.toISOString().slice(0, 19).replace('T', ' ');
                        fields.push(`${key} = ?`);
                        values.push(mysqlDatetime);
                    } catch (error) {
                        return res.status(400).json({ error: `Invalid date value for ${key}` });
                    }
                } else {
                    fields.push(`${key} = ?`);
                    values.push(null);
                }
                continue;
            }
            
            const numericFields = [
                'project_id', 'width', 'length', 'panel_thk', 'surface_front_thk', 
                'surface_back_thk', 'qty', 'balance', 'production_meter',
                'remaining_meter'
            ];
            
            if (numericFields.includes(key)) {
                if (key === 'qty' || key === 'balance' || key === 'project_id') {
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
            await connection.execute('DELETE FROM production_records WHERE panel_id = ?', [id]);
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

// GET /api/panels/:panelId/production-records - includes project_id via join
router.get('/:panelId/production-records', async (req, res) => {
    try {
        const { panelId } = req.params;
        
        const [panel] = await db.execute('SELECT id FROM panels WHERE id = ?', [panelId]);
        if (panel.length === 0) {
            return res.status(404).json({ error: 'Panel not found' });
        }
        
        const [records] = await db.execute(
            `SELECT pr.*, p.project_id 
             FROM production_records pr 
             JOIN panels p ON pr.panel_id = p.id 
             WHERE pr.panel_id = ? 
             ORDER BY pr.created_at DESC`,
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

// POST /api/panels/:panelId/production-records - no project_id needed (uses panel_id)
router.post('/:panelId/production-records', async (req, res) => {
    try {
        const { panelId } = req.params;
        const {
            number_of_panels,
            notes,
            delivery_date,
            reference_number,
            brand,
            status
        } = req.body;
        
        if (!number_of_panels || number_of_panels < 1) {
            return res.status(400).json({ error: 'Number of panels must be at least 1' });
        }
        
        const [panel] = await db.execute(
            'SELECT id, job_no, estimated_delivery, reference_number FROM panels WHERE id = ?',
            [panelId]
        );
        
        if (panel.length === 0) {
            return res.status(404).json({ error: 'Panel not found' });
        }
        
        const panelData = panel[0];
        
        const query = `
            INSERT INTO production_records 
            (panel_id, reference_number, job_no, brand, estimated_delivery, 
             delivery_date, number_of_panels, notes, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        
        const [result] = await db.execute(query, [
            panelId,
            reference_number || null,
            panelData.job_no || null,
            brand || null,
            panelData.estimated_delivery || null,
            delivery_date || null,
            parseInt(number_of_panels) || 1,
            notes || null,
            status || 'pending'
        ]);
        
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

// POST /api/panels/:panelId/production-with-balance
router.post('/:panelId/production-with-balance', async (req, res) => {
    try {
        const { panelId } = req.params;
        const {
            number_of_panels,
            notes,
            delivery_date,
            reference_number,
            brand,
            status,
            job_no,
            width,
            length,
            panel_reference
        } = req.body;
        
        if (!number_of_panels || number_of_panels < 1) {
            return res.status(400).json({ error: 'Number of panels must be at least 1' });
        }
        
        const panelsToProduce = parseInt(number_of_panels);
        const now = new Date();
        
        const result = await executeTransaction(async (connection) => {
            const [panel] = await connection.execute(
                'SELECT id, balance, qty, job_no, estimated_delivery, reference_number FROM panels WHERE id = ?',
                [panelId]
            );
            
            if (panel.length === 0) {
                throw new Error('Panel not found');
            }
            
            const panelData = panel[0];
            const currentBalance = panelData.balance || panelData.qty || 0;
            
            if (panelsToProduce > currentBalance) {
                throw new Error(`Cannot produce ${panelsToProduce} panels. Only ${currentBalance} available.`);
            }
            
            const newBalance = currentBalance - panelsToProduce;
            
            await connection.execute(
                'UPDATE panels SET balance = ?, updated_at = NOW() WHERE id = ?',
                [newBalance, panelId]
            );
            
            const query = `
                INSERT INTO production_records
                (panel_id, reference_number, job_no, brand, estimated_delivery, 
                 delivery_date, number_of_panels, notes, status, balance_after, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `;
            
            const [insertResult] = await connection.execute(query, [
                panelId,
                reference_number || panelData.reference_number,
                job_no || panelData.job_no || null,
                brand || null,
                panelData.estimated_delivery || null,
                delivery_date || null,
                panelsToProduce,
                notes || null,
                status || 'pending',
                newBalance,
                now,
                now
            ]);
            
            // Fetch the created record including project_id via join
            const [record] = await connection.execute(
                `SELECT pr.*, p.project_id 
                 FROM production_records pr 
                 JOIN panels p ON pr.panel_id = p.id 
                 WHERE pr.id = ?`,
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

// PATCH /api/panels/production-records/:id/status
router.patch('/production-records/:id/status', async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        
        if (!status) {
            return res.status(400).json({ error: 'Status is required' });
        }
        
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
            `SELECT pr.*, p.project_id 
             FROM production_records pr 
             JOIN panels p ON pr.panel_id = p.id 
             WHERE pr.id = ?`,
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

// PUT /api/panels/:panelId/production-records/:recordId
router.put('/:panelId/production-records/:recordId', async (req, res) => {
    try {
        const { panelId, recordId } = req.params;
        const updateFields = req.body;
        
        if (!updateFields || Object.keys(updateFields).length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }
        
        const [panel] = await db.execute('SELECT id FROM panels WHERE id = ?', [panelId]);
        if (panel.length === 0) {
            return res.status(404).json({ error: 'Panel not found' });
        }
        
        const [existingRecord] = await db.execute(
            'SELECT * FROM production_records WHERE id = ? AND panel_id = ?',
            [recordId, panelId]
        );
        
        if (existingRecord.length === 0) {
            return res.status(404).json({ error: 'Production record not found' });
        }
        
        const fields = [];
        const values = [];
        const allowedFields = ['date', 'number_of_panels', 'notes', 'delivery_date', 'brand', 'status'];
        
        for (const [key, value] of Object.entries(updateFields)) {
            if (!allowedFields.includes(key)) continue;
            
            if (key === 'number_of_panels') {
                if (value && value < 1) {
                    return res.status(400).json({ error: 'Number of panels must be at least 1' });
                }
                fields.push(`${key} = ?`);
                values.push(value ? parseInt(value) : null);
            } else if (key === 'status') {
                const allowedStatuses = ['pending', 'in_progress', 'completed', 'cancelled', 'on_hold'];
                if (value && !allowedStatuses.includes(value)) {
                    return res.status(400).json({ error: 'Invalid status value' });
                }
                fields.push(`${key} = ?`);
                values.push(value);
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
        
        const [updatedRecord] = await db.execute(
            `SELECT pr.*, p.project_id 
             FROM production_records pr 
             JOIN panels p ON pr.panel_id = p.id 
             WHERE pr.id = ?`,
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

// DELETE /api/panels/:panelId/production-records/:recordId
router.delete('/:panelId/production-records/:recordId', async (req, res) => {
    try {
        const { panelId, recordId } = req.params;
        
        const result = await executeTransaction(async (connection) => {
            const [panel] = await connection.execute(
                'SELECT id, balance FROM panels WHERE id = ?',
                [panelId]
            );
            
            if (panel.length === 0) {
                throw new Error('Panel not found');
            }
            
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
            const newBalance = currentBalance + panelsToRestore;
            
            await connection.execute(
                'UPDATE panels SET balance = ?, updated_at = NOW() WHERE id = ?',
                [newBalance, panelId]
            );
            
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

// DELETE /api/panels/:panelId/production/:recordId/with-balance
router.delete('/:panelId/production/:recordId/with-balance', async (req, res) => {
    try {
        const { panelId, recordId } = req.params;
        
        const result = await executeTransaction(async (connection) => {
            const [panel] = await connection.execute(
                'SELECT id, balance FROM panels WHERE id = ?',
                [panelId]
            );
            
            if (panel.length === 0) {
                throw new Error('Panel not found');
            }
            
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
            const newBalance = currentBalance + panelsToRestore;
            
            await connection.execute(
                'UPDATE panels SET balance = ?, updated_at = NOW() WHERE id = ?',
                [newBalance, panelId]
            );
            
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

// GET /api/panels/:panelId/production-summary - includes project_id
router.get('/:panelId/production-summary', async (req, res) => {
    try {
        const { panelId } = req.params;
        
        const [panel] = await db.execute(
            'SELECT id, qty, balance, production_meter, status, project_id FROM panels WHERE id = ?',
            [panelId]
        );
        
        if (panel.length === 0) {
            return res.status(404).json({ error: 'Panel not found' });
        }
        
        const panelData = panel[0];
        
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
            project_id: panelData.project_id,   // ✅ included
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

// PUT /api/panels/:id/balance
router.put('/:id/balance', async (req, res) => {
    try {
        const { id } = req.params;
        const { balance } = req.body;
        
        if (balance === undefined || balance === null) {
            return res.status(400).json({ error: 'Balance is required' });
        }
        
        const [panel] = await db.execute('SELECT id FROM panels WHERE id = ?', [id]);
        if (panel.length === 0) {
            return res.status(404).json({ error: 'Panel not found' });
        }
        
        await db.execute(
            'UPDATE panels SET balance = ?, updated_at = NOW() WHERE id = ?',
            [parseInt(balance), id]
        );
        
        const [updatedPanel] = await db.execute(
            'SELECT id, balance, qty, project_id FROM panels WHERE id = ?',
            [id]
        );
        
        res.json({
            success: true,
            panel_id: id,
            project_id: updatedPanel[0].project_id,
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

// GET /api/panels/:id/balance-history
router.get('/:id/balance-history', async (req, res) => {
    try {
        const { id } = req.params;
        
        const [panel] = await db.execute('SELECT id FROM panels WHERE id = ?', [id]);
        if (panel.length === 0) {
            return res.status(404).json({ error: 'Panel not found' });
        }
        
        const [records] = await db.execute(
            `SELECT pr.*, p.project_id, p.balance as current_balance 
             FROM production_records pr 
             JOIN panels p ON pr.panel_id = p.id 
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

// GET /api/panels/stats/summary
router.get('/stats/summary', async (req, res) => {
    try {
        const [totalPanels] = await db.execute('SELECT COUNT(*) as count FROM panels');
        const [totalQty] = await db.execute('SELECT SUM(qty) as total FROM panels');
        const [totalProduced] = await db.execute('SELECT SUM(number_of_panels) as total FROM production_records');
        const [totalBalance] = await db.execute('SELECT SUM(balance) as total FROM panels');
        const [totalProductionMeter] = await db.execute('SELECT SUM(production_meter) as total FROM panels');
        
        const [balanceStats] = await db.execute(`
            SELECT 
                COUNT(CASE WHEN balance > 0 THEN 1 END) as positive,
                COUNT(CASE WHEN balance = 0 THEN 1 END) as zero,
                COUNT(CASE WHEN balance < 0 THEN 1 END) as negative,
                COUNT(CASE WHEN balance <= qty * 0.1 AND balance > 0 THEN 1 END) as low
            FROM panels
        `);
        
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

// GET /api/panels/production-records/all - includes project_id via join
router.get('/production-records/all', async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT 
                pr.*,
                p.project_id,
                p.reference_number AS panel_ref,
                p.joint,
                p.type,
                p.panel_thk,
                p.surface_front,
                p.surface_back,
                p.surface_front_thk,
                p.surface_back_thk,
                p.surface_type,
                p.width,
                p.length,
                p.application,
                p.cutting,
                p.qty AS panel_qty,
                p.balance AS panel_balance
            FROM production_records pr
            LEFT JOIN panels p ON pr.panel_id = p.id
            ORDER BY pr.created_at DESC
        `);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching production records with panel data:', err);
        res.status(500).json({ error: 'Failed to fetch production records' });
    }
});

// GET /api/panels/production-records/by-date?date=YYYY-MM-DD
router.get('/production-records/by-date', async (req, res) => {
    try {
        const { date } = req.query;
        if (!date) {
            return res.status(400).json({ error: 'Date query parameter is required (YYYY-MM-DD)' });
        }

        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
        }

        const query = `
            SELECT 
                pr.*,
                p.project_id,
                p.id as panel_table_id,
                p.reference_number as panel_reference_number,
                p.job_no as panel_job_no,
                p.length as panel_length,
                p.width as panel_width,
                p.type as panel_type,
                p.panel_thk as panel_thickness,
                p.joint as panel_joint,
                p.surface_front,
                p.surface_back,
                p.surface_type,
                p.qty as panel_qty,
                p.balance as panel_balance,
                p.production_meter,
                p.salesman,
                p.notes as panel_notes,
                p.created_at as panel_created_at
            FROM production_records pr
            LEFT JOIN panels p ON pr.panel_id = p.id
            WHERE DATE(pr.created_at) = ?
            ORDER BY pr.created_at DESC
        `;

        const [records] = await db.execute(query, [date]);

        // Format response with nested panel object (same as /all endpoint)
        const formattedRecords = records.map(record => {
            const response = {
                ...record,
                panel: {
                    id: record.panel_table_id,
                    project_id: record.project_id,   // ✅ added
                    reference_number: record.panel_reference_number,
                    job_no: record.panel_job_no,
                    length: record.panel_length,
                    width: record.panel_width,
                    type: record.panel_type,
                    panel_thk: record.panel_thickness,
                    joint: record.panel_joint,
                    surface_front: record.surface_front,
                    surface_back: record.surface_back,
                    surface_type: record.surface_type,
                    qty: record.panel_qty,
                    balance: record.panel_balance,
                    production_meter: record.production_meter,
                    salesman: record.salesman,
                    notes: record.panel_notes,
                    created_at: record.panel_created_at
                }
            };

            delete response.panel_table_id;
            delete response.panel_reference_number;
            delete response.panel_job_no;
            delete response.panel_length;
            delete response.panel_width;
            delete response.panel_type;
            delete response.panel_thickness;
            delete response.panel_joint;
            delete response.surface_front;
            delete response.surface_back;
            delete response.surface_type;
            delete response.panel_qty;
            delete response.panel_balance;
            delete response.production_meter;
            delete response.salesman;
            delete response.panel_notes;
            delete response.panel_created_at;

            return response;
        });

        res.json(formattedRecords);
    } catch (error) {
        console.error('Error fetching production records by date:', error);
        res.status(500).json({ 
            error: 'Failed to fetch production records by date',
            details: error.message 
        });
    }
});

// DELETE /api/panels/by-job/:job_no - now uses panel_id for production records (already correct)
router.delete('/by-job/:job_no', async (req, res) => {
    try {
        const { job_no } = req.params;

        if (!job_no) {
            return res.status(400).json({ error: 'Job number is required' });
        }

        const result = await executeTransaction(async (connection) => {
            const [panels] = await connection.execute(
                'SELECT id FROM panels WHERE job_no = ?',
                [job_no]
            );

            if (panels.length === 0) {
                throw new Error('No panels found with this job number');
            }

            const panelIds = panels.map(p => p.id);
            const placeholders = panelIds.map(() => '?').join(',');

            const [deleteProdResult] = await connection.execute(
                `DELETE FROM production_records WHERE panel_id IN (${placeholders})`,
                panelIds
            );

            const [deletePanelResult] = await connection.execute(
                `DELETE FROM panels WHERE job_no = ?`,
                [job_no]
            );

            return {
                success: true,
                message: `All panels with job number ${job_no} and their production records deleted successfully`,
                deleted_panels: deletePanelResult.affectedRows,
                deleted_production_records: deleteProdResult.affectedRows
            };
        });

        res.json(result);
    } catch (error) {
        console.error('Error deleting panels by job number:', error);
        if (error.message === 'No panels found with this job number') {
            return res.status(404).json({ error: error.message });
        }
        res.status(500).json({ 
            error: 'Failed to delete panels by job number',
            details: error.message 
        });
    }
});

module.exports = router;