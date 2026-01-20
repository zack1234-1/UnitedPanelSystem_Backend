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
            created_at, // Added this line
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
        
        // Calculate initial balance (set to qty if not provided)
        const initialBalance = balance !== undefined ? parseInt(balance) : qtyInt;
        
        // Calculate initial production meter: length * (qty - balance)
        // If balance is same as qty (new panel), production meter should be 0
        // If balance is less than qty (already produced some), production meter should be positive
        const calculatedProductionMeter = (lengthFloat * (qtyInt - initialBalance)) || 0;
        
        // Use calculated production meter unless explicitly provided
        const finalProductionMeter = production_meter !== undefined ? 
            parseFloat(production_meter) : calculatedProductionMeter;
        
        // If created_at is not provided, use current date/time
        // If it's provided but empty string, set to null
        let createdAtValue = created_at;
        if (!created_at || created_at.trim() === '') {
            createdAtValue = new Date(); // Current date/time
        }
        
        // Insert into database with application and created_at fields
        const query = `
            INSERT INTO panels 
            (reference_number, job_no, type, panel_thk, joint, 
             surface_front, surface_back, surface_front_thk, surface_back_thk, 
             surface_type, width, length, qty, cutting, 
             balance, production_meter, brand, estimated_delivery, 
             created_at, salesman, notes, application, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            widthFloat,
            lengthFloat,
            qtyInt,
            cutting || null,
            initialBalance,
            finalProductionMeter,
            brand || null,
            estimated_delivery || null,
            createdAtValue, // Added this parameter
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
            details: error.message 
        });
    }
});

// POST /api/panels/:id/duplicate - Duplicate a panel
router.post('/:id/duplicate', async (req, res) => {
    try {
        const { id } = req.params;

        // 1. Get the panel to duplicate
        const [panels] = await db.execute('SELECT * FROM panels WHERE id = ?', [id]);

        if (panels.length === 0) {
            return res.status(404).json({ error: 'Panel not found' });
        }

        const panelData = panels[0];

        // 2. Generate new reference number
        const referenceNumber = await generateReferenceNumber();

        // 3. Handle the Date Formatting Safely
        let formattedDate = null;
        if (panelData.estimated_delivery) {
            const dateObj = new Date(panelData.estimated_delivery);
            if (!isNaN(dateObj.getTime())) {
                // Converts "2026-01-10T00:00:00.000Z" to "2026-01-10"
                formattedDate = dateObj.toISOString().split('T')[0];
            }
        }

        // 4. Prepare the insert query
        const sql = `INSERT INTO panels 
            (reference_number, job_no, type, panel_thk, joint, 
             surface_front, surface_back, surface_front_thk, surface_back_thk, 
             surface_type, width, length, qty, cutting, 
             balance, production_meter, brand, estimated_delivery, 
             salesman, notes, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

        const values = [
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
            panelData.qty || 0, // Setting balance to initial qty
            panelData.production_meter,
            panelData.brand,
            formattedDate,      // The cleaned YYYY-MM-DD date
            panelData.salesman,
            null,               // Notes set to null as per your logic
            'pending'           // Status set to pending
        ];

        // 5. Execute Insert
        const [result] = await db.execute(sql, values);

        // 6. Fetch and return the newly created panel
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
        
        // Get current panel data to calculate production meter if needed
        let currentPanel = null;
        let needsProductionMeterCalculation = false;
        
        // Check if we need to calculate production meter
        if (updateFields.length !== undefined || updateFields.qty !== undefined || updateFields.balance !== undefined) {
            // Fetch current panel to get all values
            const [current] = await db.execute('SELECT * FROM panels WHERE id = ?', [id]);
            if (current.length === 0) {
                return res.status(404).json({ error: 'Panel not found' });
            }
            currentPanel = current[0];
            needsProductionMeterCalculation = true;
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
            
            // Mark that we need to recalculate production meter since balance changed
            needsProductionMeterCalculation = true;
            if (!currentPanel) {
                const [current] = await db.execute('SELECT * FROM panels WHERE id = ?', [id]);
                currentPanel = current[0];
            }
        }
        
        // Recalculate production meter if needed
        if (needsProductionMeterCalculation && currentPanel) {
            // Only recalculate if production_meter is not explicitly provided in the update
            if (updateFields.production_meter === undefined) {
                // Use updated values if provided, otherwise use current values
                const newLength = updateFields.length !== undefined ? 
                    parseFloat(updateFields.length) : parseFloat(currentPanel.length);
                const newQty = updateFields.qty !== undefined ? 
                    parseInt(updateFields.qty) : parseInt(currentPanel.qty);
                const newBalance = updateFields.balance !== undefined ? 
                    parseInt(updateFields.balance) : parseInt(currentPanel.balance);
                
                // Calculate production meter: length * (qty - balance)
                const calculatedProductionMeter = newLength * (newQty - newBalance);
                
                // Ensure it's not negative (in case balance > qty due to data issues)
                updateFields.production_meter = Math.max(0, calculatedProductionMeter);
            }
        }
        
        // Define allowed fields that can be updated
        const allowedFields = [
            'reference_number', 'job_no', 'type', 'panel_thk', 'joint',
            'surface_front', 'surface_back', 'surface_front_thk', 'surface_back_thk',
            'surface_type', 'width', 'length', 'qty', 'cutting',
            'balance', 'production_meter', 'brand', 'estimated_delivery',
            'salesman', 'notes', 'status', 'application', 'created_at'  // Added created_at
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
            'SELECT * FROM production_records WHERE panel_id = ? ORDER BY created_at DESC',
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
            number_of_panels,
            notes,
            delivery_date,
            reference_number
        } = req.body;
        
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
             delivery_date, number_of_panels, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        
        const [result] = await db.execute(query, [
            panelId,
            reference_number || null,
            panelData.job_no || null,
            panelData.brand || null,
            panelData.estimated_delivery || null,
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
            number_of_panels,
            notes,
            delivery_date,
            reference_number
        } = req.body;
        
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
                 delivery_date, number_of_panels, notes, balance_after)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?,?)
            `;
            
            const [insertResult] = await connection.execute(query, [
                panelId,
                reference_number || panelData.reference_number,
                panelData.job_no || null,
                panelData.brand || null,
                panelData.estimated_delivery || null,
                delivery_date || null,
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

router.get('/production-records/all', async (req, res) => {
    try {
        // SQL query with proper table aliases
        const query = `
            SELECT 
                pr.*,
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
            ORDER BY pr.created_at DESC
        `;
        
        // Execute query - adjust based on your database library
        // For mysql2/promise:
        const [allRecords] = await db.query(query);
        
        // Or for node-postgres:
        // const result = await db.query(query);
        // const allRecords = result.rows;
        
        // Format the response to match your original structure if needed
        const formattedRecords = allRecords.map(record => {
            // Create a clean response object
            const response = {
                ...record,
                panel: {
                    id: record.panel_table_id,
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
            
            // Remove the aliased panel fields from the main object
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
        console.error('Error fetching production records:', error);
        res.status(500).json({ 
            error: 'Failed to fetch production records',
            details: error.message 
        });
    }
});

module.exports = router;
