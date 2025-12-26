const express = require('express');
const router = express.Router();
const db = require('../db/connection');

// POST /api/orders - Create a new order
router.post('/', async (req, res) => {
    try {
        const { task_id, project_no, task_title, items, status, category } = req.body;
        
        // Basic validation
        if (!task_id || !project_no || !task_title || !items || !Array.isArray(items)) {
            return res.status(400).json({ 
                error: 'task_id, project_no, task_title, and items array are required' 
            });
        }
        
        // Validate each item
        for (const item of items) {
            if (!item.description || !item.quantity) {
                return res.status(400).json({ 
                    error: 'Each item must have description and quantity' 
                });
            }
        }
        
        // Insert into database
        const query = `
            INSERT INTO orders 
            (task_id, project_no, task_title, items, status, category)
            VALUES (?, ?, ?, ?, ?, ?)
        `;
        
        const [result] = await db.execute(query, [
            task_id,
            project_no,
            task_title,
            JSON.stringify(items),
            status || 'pending',
            category || 'Accessories'
        ]);
        
        // Return the created order
        const [order] = await db.execute(
            'SELECT * FROM orders WHERE id = ?',
            [result.insertId]
        );
        
        // Parse items JSON string back to array
        const orderData = order[0];
        orderData.items = JSON.parse(orderData.items);
        
        res.status(201).json(orderData);
        
    } catch (error) {
        console.error('Error creating order:', error);
        res.status(500).json({ error: 'Failed to create order' });
    }
});

// PUT /api/orders/:id - Update order status only - Simplest version
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        
        console.log('DEBUG: Received:', { id, status, body: req.body });
        
        if (!status) {
            return res.status(400).json({ error: 'Status is required' });
        }
        
        // Simple direct query
        const sql = `UPDATE orders SET status = '${status}', updated_at = NOW() WHERE id = ${id}`;
        console.log('DEBUG: SQL:', sql);
        
        const [result] = await db.query(sql);
        console.log('DEBUG: Result:', result);
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }
        
        // Get updated order
        const [updatedOrder] = await db.query(`SELECT * FROM orders WHERE id = ${id}`);
        
        if (updatedOrder.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }
        
        const orderData = updatedOrder[0];
        if (orderData.items) {
            orderData.items = JSON.parse(orderData.items);
        }
        
        res.json(orderData);
        
    } catch (error) {
        console.error('ERROR:', error);
        res.status(500).json({ 
            error: 'Failed to update order status',
            details: error.message 
        });
    }
});

// GET /api/orders - Get all orders
router.get('/', async (req, res) => {
    try {
        const [orders] = await db.execute('SELECT * FROM orders ORDER BY created_at DESC');
        
        // Parse items JSON string for each order
        orders.forEach(order => {
            if (order.items) {
                order.items = JSON.parse(order.items);
            }
        });
        
        res.json(orders);
    } catch (error) {
        console.error('Error fetching orders:', error);
        res.status(500).json({ error: 'Failed to fetch orders' });
    }
});

// GET /api/orders/task/:taskId - Get orders by task ID
router.get('/task/:taskId', async (req, res) => {
    try {
        const { taskId } = req.params;
        const [orders] = await db.execute(
            'SELECT * FROM orders WHERE task_id = ? ORDER BY created_at DESC',
            [taskId]
        );
        
        // Parse items JSON string for each order
        orders.forEach(order => {
            if (order.items) {
                order.items = JSON.parse(order.items);
            }
        });
        
        res.json(orders);
    } catch (error) {
        console.error('Error fetching orders by task:', error);
        res.status(500).json({ error: 'Failed to fetch orders for this task' });
    }
});

// DELETE /api/orders/:id - Delete an order
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        const [result] = await db.execute(
            'DELETE FROM orders WHERE id = ?',
            [id]
        );
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }
        
        res.status(204).end(); // No content
        
    } catch (error) {
        console.error('Error deleting order:', error);
        res.status(500).json({ error: 'Failed to delete order' });
    }
});

module.exports = router;