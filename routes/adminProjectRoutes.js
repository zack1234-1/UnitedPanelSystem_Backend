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

router.post('/', async (req, res) => {
    // Destructure request body
    const { 
        Date_Entry, 
        Job_No, 
        Customer_Name, 
        Sales_Amount, 
        Sell_Price, 
        Cost, 
        Margin, 
        Remarks,
        Signature_Data
    } = req.body;
    
    // List of all task tables to update
    const TASK_TABLES = [
        'panel_tasks', 'cutting_tasks', 'door_tasks', 
        'strip_curtain_tasks', 'accessories_tasks', 'system_tasks', 
        'transportation_tasks', 'quotation_tasks'
    ];

    // Basic validation
    if (!Job_No || !Date_Entry || Sales_Amount === undefined || Sell_Price === undefined || Cost === undefined) {
        return res.status(400).json({ error: 'Job_No, Date_Entry, Sales_Amount, Sell_Price, and Cost are required.' });
    }

    const insertSql = `
        INSERT INTO ${TABLE_NAME} (
            Date_Entry, Job_No, Customer_Name, Sales_Amount, Sell_Price, Cost, 
            Margin, Remarks, Signature_Data
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    
    // --- 1. Get a connection from the pool and start a transaction ---
    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        // 2. Check if job exists (Using the connection)
        const [existing] = await connection.execute(`SELECT Job_No FROM ${TABLE_NAME} WHERE Job_No = ?`, [Job_No]);
        if (existing.length > 0) {
            await connection.rollback();
            return res.status(409).json({ error: `Job with Job No ${Job_No} already exists.` });
        }
        
        // 3. Convert base64 to Buffer for BLOB storage
        let signatureBuffer = null;
        let hasSignature = false;
        if (Signature_Data && Signature_Data.startsWith('data:image/')) {
            const base64Data = Signature_Data.replace(/^data:image\/\w+;base64,/, '');
            signatureBuffer = Buffer.from(base64Data, 'base64');
            hasSignature = true;
        }
        
        // 4. Insert the new job record (Using the connection)
        await connection.execute(insertSql, [
            Date_Entry, 
            Job_No, 
            Customer_Name || null, 
            Sales_Amount, 
            Sell_Price, 
            Cost,
            Margin || null, 
            Remarks || null,
            signatureBuffer
        ]);

        let statusUpdateMessage = 'Job record created successfully.';

        // 5. Conditional Updates if Signature Exists
        if (hasSignature) {
            // --- A. Update Project Status ---
            await connection.execute(
                `UPDATE projects SET status = 'Approved' WHERE projectNo = ?`,
                [Job_No]
            );
            console.log(`✅ Project ${Job_No} status updated to Approved.`);

            // --- B. Update All Category Task Statuses ---
            const updatePromises = TASK_TABLES.map(table => {
                return connection.execute(
                    `UPDATE ${table} SET approve_status = 'approved' WHERE project_no = ? AND status = 'pending'`,
                    [Job_No]
                );
            });
            
            // Wait for all task table updates to complete
            await Promise.all(updatePromises);
            
            console.log(`✅ All pending tasks for project ${Job_No} updated to 'approved'.`);
            statusUpdateMessage = `Job created, project status updated, and all pending category tasks set to 'approved'.`;
        }

        // 6. Commit the transaction
        await connection.commit();

        // 7. Return created job
        const [rows] = await pool.execute(`SELECT * FROM ${TABLE_NAME} WHERE Job_No = ?`, [Job_No]);
        
        // Note: You need to define the 'formatJob' function somewhere for this to work
        res.status(201).json({
            job: rows[0] ? formatJob(rows[0]) : { Job_No }, // Fallback if re-fetching fails
            message: statusUpdateMessage
        });
        
    } catch (err) {
        // --- ROLLBACK on error ---
        if (connection) {
            await connection.rollback();
        }
        console.error('Error creating job and updating statuses:', err);
        return res.status(500).json({ error: 'Failed to create job or update associated statuses.' });
    } finally {
        // --- 8. Release the connection ---
        if (connection) {
            connection.release();
        }
    }
});

// PUT /api/admin/jobs/:jobNo - Update Job
// PUT /api/admin/jobs/:jobNo - Update Job
router.put('/:jobNo', async (req, res) => {
    const TABLE_NAME = 'job_ledger';
    const jobNo = req.params.jobNo;  // This is the OLD job number from URL
    const updates = req.body;
    
    // List of all task tables to update
    const TASK_TABLES = [
        'panel_tasks', 'cutting_tasks', 'door_tasks', 
        'strip_curtain_tasks', 'accessories_tasks', 'system_tasks', 
        'transportation_tasks', 'quotation_tasks'
    ];
    
    // Allowed fields - ADD 'Job_No' to this array
    const allowedFields = [
        'Job_No', // ADD THIS LINE - allow Job_No to be updated
        'Date_Entry', 'Customer_Name', 'Sales_Amount', 'Sell_Price', 
        'Cost', 'Margin', 'Remarks', 'Signature_Data'
    ];
    
    const fieldsToUpdate = [];
    const updateValues = [];

    // Track if signature is being added or changed to a non-null value
    let hasNewSignature = false;
    let newJobNo = jobNo; // Default to old job number

    for (const field of allowedFields) {
        if (updates[field] !== undefined) {
            fieldsToUpdate.push(`${field} = ?`);
            
            let value = updates[field];
            
            // Handle signature BLOB conversion
            if (field === 'Signature_Data') {
                if (!value || value === '') {
                    value = null; // Set to NULL in database
                } else if (typeof value === 'string' && value.startsWith('data:image/')) {
                    const base64Data = value.replace(/^data:image\/\w+;base64,/, '');
                    value = Buffer.from(base64Data, 'base64');
                    hasNewSignature = true; // Signature provided or updated
                }
            } 
            // Handle Job_No update - store the new value
            else if (field === 'Job_No') {
                newJobNo = value; // Update newJobNo variable
            }
            // Handle empty strings for text/numeric fields to be NULL
            else if (typeof value === 'string' && value.trim() === '' && 
                     ['Customer_Name', 'Remarks'].includes(field)) {
                value = null;
            } 
            // Handle Margin (which can be 0 or null)
            else if (field === 'Margin' && (value === null || value === '')) {
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
    const finalBindValues = [...updateValues, jobNo]; // WHERE clause uses OLD job number

    let connection;
    let statusUpdateMessage = '';
    
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        // 1. Execute the job update
        const [result] = await connection.execute(updateSql, finalBindValues);
        
        if (result.affectedRows === 0) {
            await connection.rollback();
            return res.status(404).json({ error: `Job with Job No ${jobNo} not found.` });
        }
        
        // 2. If job number changed, update all related task tables
        if (newJobNo !== jobNo) {
            console.log(`🔄 Job number changed from ${jobNo} to ${newJobNo}. Updating related tables...`);
            
            // Update all task tables with new project number
            const updateTaskPromises = TASK_TABLES.map(table => {
                return connection.execute(
                    `UPDATE ${table} SET project_no = ? WHERE project_no = ?`,
                    [newJobNo, jobNo]
                );
            });
            
            // Update projects table
            const updateProjectPromise = connection.execute(
                `UPDATE projects SET projectNo = ? WHERE projectNo = ?`,
                [newJobNo, jobNo]
            );
            
            // Wait for all updates
            await Promise.all([...updateTaskPromises, updateProjectPromise]);
            
            console.log(`✅ All related tables updated with new job number ${newJobNo}`);
            statusUpdateMessage = `Job updated and job number changed from ${jobNo} to ${newJobNo}.`;
        }
        
        // 3. Conditional Updates if a new signature is provided (Approval Trigger)
        if (hasNewSignature) {
            const jobNoToUse = newJobNo !== jobNo ? newJobNo : jobNo;
            
            // Update Project Status
            await connection.execute(
                `UPDATE projects SET status = 'Approved' WHERE projectNo = ?`,
                [jobNoToUse]
            );
            console.log(`✅ Project ${jobNoToUse} status updated to Approved due to signature update`);

            // Update All Category Task Statuses
            const updatePromises = TASK_TABLES.map(table => {
                return connection.execute(
                    `UPDATE ${table} 
                     SET status = 'pending', approve_status = 'Approved' 
                     WHERE project_no = ? AND status = 'pending'`,
                    [jobNoToUse]
                );
            });
            
            await Promise.all(updatePromises);
            console.log(`✅ All pending tasks for project ${jobNoToUse} updated to 'approved'/'Signed'.`);
            
            statusUpdateMessage += ` Project status updated and all pending category tasks set to 'approved'.`;
        } else {
            statusUpdateMessage = statusUpdateMessage || `Job updated successfully.`;
        }

        // 4. Commit the transaction
        await connection.commit();

        // 5. Return updated job (query with NEW job number)
        const [rows] = await pool.execute(
            `SELECT * FROM ${TABLE_NAME} WHERE Job_No = ?`, 
            [newJobNo] // Query with NEW job number
        );
        
        res.json({
            job: rows[0] ? formatJob(rows[0]) : { Job_No: newJobNo },
            message: statusUpdateMessage
        });
    } catch (err) {
        if (connection) {
            await connection.rollback();
        }
        console.error(`Error updating job ${jobNo}:`, err);
        return res.status(500).json({ 
            error: 'Failed to update job or associated tables.',
            details: err.message 
        });
    } finally {
        if (connection) {
            connection.release();
        }
    }
});

// --- DELETE /api/projects/:jobNo ---
router.delete('/:jobNo', async (req, res) => {
    // 1. Get the jobNo from params (e.g., "UPS/0625/19536")
    const rawJobNo = req.params.jobNo;

    // 2. Sanitize: Replace / with _ to match how we stored it in the POST route
    const safeJobNo = rawJobNo.replace(/\//g, '_');

    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        // 3. Delete from job_ledger (Using Job_No column)
        // Note: Replace 'job_ledger' with ${TABLE_NAME} if you are using a variable
        const [deleteLedger] = await connection.execute(
            `DELETE FROM job_ledger WHERE Job_No = ?`, 
            [safeJobNo]
        );

        // 4. Delete from projects (Using projectNo column)
        const [deleteProject] = await connection.execute(
            `DELETE FROM projects WHERE projectNo = ?`, 
            [safeJobNo]
        );

        // 5. Check if anything was actually deleted
        if (deleteLedger.affectedRows === 0 && deleteProject.affectedRows === 0) {
            await connection.rollback();
            return res.status(404).json({ error: `No records found for Job No: ${safeJobNo}` });
        }

        await connection.commit();
        
        res.status(200).json({ 
            message: `Job and Project ${safeJobNo} deleted successfully` 
        });

    } catch (err) {
        await connection.rollback(); 
        console.error(`Error deleting job ${safeJobNo}:`, err);
        return res.status(500).json({ error: 'Failed to delete records from database' });
    } finally {
        connection.release(); 
    }
});

module.exports = router;