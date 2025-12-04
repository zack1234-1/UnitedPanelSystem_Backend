const express = require('express');
const router = express.Router();
const pool = require('../db/connection'); 

const TABLE_NAME = 'job_ledger';

// Helper function to format database output
const formatJob = (job) => {
    // Convert BLOB to base64 data URL for frontend
    let signatureData = null;
    if (job.Signature_Data && Buffer.isBuffer(job.Signature_Data)) {
        const base64String = job.Signature_Data.toString('base64');
        signatureData = `data:image/png;base64,${base64String}`;
    }
    
    return {
        recordId: job.Record_ID,
        dateEntry: job.Date_Entry,
        jobNo: job.Job_No,
        customerName: job.Customer_Name,
        salesAmount: job.Sales_Amount,
        sellPrice: job.Sell_Price,
        cost: job.Cost,
        margin: job.Margin,
        approvalStatus: job.Approval_Status,
        remarks: job.Remarks,
        signatureData: signatureData,
    };
};

// GET /api/admin/jobs - Fetch All Jobs
router.get('/', async (req, res) => {
    const query = `SELECT * FROM ${TABLE_NAME} ORDER BY Date_Entry DESC`;
    try {
        const [results] = await pool.execute(query);
        res.json(results.map(formatJob));
    } catch (err) {
        console.error('Error fetching all jobs for admin:', err);
        return res.status(500).json({ error: 'Failed to fetch job list' });
    }
});

// GET /api/admin/jobs/:jobNo - Fetch Single Job
router.get('/:jobNo', async (req, res) => {
    const jobNo = req.params.jobNo;
    const query = `SELECT * FROM ${TABLE_NAME} WHERE Job_No = ?`;
    try {
        const [results] = await pool.execute(query, [jobNo]);
        
        if (results.length === 0) {
            return res.status(404).json({ error: `Job with Job No ${jobNo} not found` });
        }
        
        res.json(formatJob(results[0]));
    } catch (err) {
        console.error(`Error fetching job ${jobNo}:`, err);
        return res.status(500).json({ error: 'Failed to fetch job' });
    }
});

// POST /api/admin/jobs - Create New Job
router.post('/', async (req, res) => {
    const { 
        Date_Entry, 
        Job_No, 
        Customer_Name, 
        Sales_Amount, 
        Sell_Price, 
        Cost, 
        Margin, 
        Approval_Status, 
        Remarks,
        Signature_Data
    } = req.body;
    
    // Basic validation
    if (!Job_No || !Date_Entry || Sales_Amount === undefined || Sell_Price === undefined || Cost === undefined) {
        return res.status(400).json({ error: 'Job_No, Date_Entry, Sales_Amount, Sell_Price, and Cost are required.' });
    }

    const insertSql = `
        INSERT INTO ${TABLE_NAME} (
            Date_Entry, Job_No, Customer_Name, Sales_Amount, Sell_Price, Cost, 
            Margin, Approval_Status, Remarks, Signature_Data
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    
    try {
        // Check if job exists
        const [existing] = await pool.execute(`SELECT Job_No FROM ${TABLE_NAME} WHERE Job_No = ?`, [Job_No]);
        if (existing.length > 0) {
            return res.status(409).json({ error: `Job with Job No ${Job_No} already exists.` });
        }
        
        // Convert base64 to Buffer for BLOB storage
        let signatureBuffer = null;
        if (Signature_Data && Signature_Data.startsWith('data:image/')) {
            const base64Data = Signature_Data.replace(/^data:image\/\w+;base64,/, '');
            signatureBuffer = Buffer.from(base64Data, 'base64');
        }
        
        await pool.execute(insertSql, [
            Date_Entry, 
            Job_No, 
            Customer_Name || null, 
            Sales_Amount, 
            Sell_Price, 
            Cost,
            Margin || null, 
            Approval_Status || 'Pending',
            Remarks || null,
            signatureBuffer
        ]);

        // Return created job
        const [rows] = await pool.execute(`SELECT * FROM ${TABLE_NAME} WHERE Job_No = ?`, [Job_No]);
        res.status(201).json(formatJob(rows[0]));
    } catch (err) {
        console.error('Error creating job:', err);
        return res.status(500).json({ error: 'Failed to create job' });
    }
});

// PUT /api/admin/jobs/:jobNo - Update Job
router.put('/:jobNo', async (req, res) => {
    const jobNo = req.params.jobNo;
    const updates = req.body;
    
    // Allowed fields
    const allowedFields = [
        'Date_Entry', 'Customer_Name', 'Sales_Amount', 'Sell_Price', 
        'Cost', 'Margin', 'Approval_Status', 'Remarks', 'Signature_Data'
    ];
    
    const fieldsToUpdate = [];
    const updateValues = [];

    for (const field of allowedFields) {
        if (updates[field] !== undefined) {
            fieldsToUpdate.push(`${field} = ?`);
            
            let value = updates[field];
            
            // Handle signature BLOB conversion
            if (field === 'Signature_Data') {
                if (!value || value === '') {
                    value = null;
                } else if (value.startsWith('data:image/')) {
                    const base64Data = value.replace(/^data:image\/\w+;base64,/, '');
                    value = Buffer.from(base64Data, 'base64');
                }
            } 
            // Handle empty strings for text fields
            else if (typeof value === 'string' && value.trim() === '' && ['Customer_Name', 'Remarks', 'Margin'].includes(field)) {
                value = null;
            }
            
            updateValues.push(value);
        }
    }

    if (fieldsToUpdate.length === 0) {
        return res.status(400).json({ error: 'No valid fields provided for update.' });
    }

    const setClause = fieldsToUpdate.join(', ');
    const updateSql = `UPDATE ${TABLE_NAME} SET ${setClause} WHERE Job_No = ?`;
    const finalBindValues = [...updateValues, jobNo];

    try {
        const [result] = await pool.execute(updateSql, finalBindValues);
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: `Job with Job No ${jobNo} not found.` });
        }
        
        // Return updated job
        const [rows] = await pool.execute(`SELECT * FROM ${TABLE_NAME} WHERE Job_No = ?`, [jobNo]);
        res.json(formatJob(rows[0]));
    } catch (err) {
        console.error(`Error updating job ${jobNo}:`, err);
        return res.status(500).json({ error: 'Failed to update job' });
    }
});

// DELETE /api/admin/jobs/:jobNo - Delete Job
router.delete('/:jobNo', async (req, res) => {
    const jobNo = req.params.jobNo;
    
    try {
        const [results] = await pool.execute(`DELETE FROM ${TABLE_NAME} WHERE Job_No = ?`, [jobNo]);
        
        if (results.affectedRows === 0) {
            return res.status(404).json({ error: 'Job not found' });
        }
        
        res.status(200).json({ message: `Job ${jobNo} deleted successfully` });
    } catch (err) {
        console.error(`Error deleting job ${jobNo}:`, err);
        return res.status(500).json({ error: 'Failed to delete job' });
    }
});

module.exports = router;