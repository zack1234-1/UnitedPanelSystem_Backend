const express = require('express');
const router = express.Router();
const pool = require('../db/connection'); 

const TABLE_NAME = 'job_ledger';

// Helper: format job for response
const formatJob = (job) => {
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

// ============================================================
// HELPER: Generate reference number in format REF-YYMMDD-XXX
// ============================================================
async function generateReferenceNumber(connection) {
    const now = new Date();
    const year = now.getFullYear().toString().slice(-2);
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const prefix = `REF-${year}${month}${day}`;
    
    const [rows] = await connection.execute(
        `SELECT reference_number FROM panels WHERE reference_number LIKE ? ORDER BY reference_number DESC LIMIT 1`,
        [`${prefix}-%`]
    );
    let nextSeq = 1;
    if (rows.length > 0) {
        const last = rows[0].reference_number;
        const match = last.match(/\d+$/);
        if (match) {
            nextSeq = parseInt(match[0]) + 1;
        }
    }
    return `${prefix}-${String(nextSeq).padStart(3, '0')}`;
}

// ============================================================
// HELPER: Create or update panels record for a job
// - Fetches salesman and requestedDelivery from projects table
//   using jobNo as projectNo, then uses them as defaults.
// - Override values (estimatedDelivery, salesman) take precedence.
// - **ALWAYS sets panel status to 'pending'** (on sign/approval)
// ============================================================
async function createOrUpdatepanelsForJob(connection, jobNo, remarks, overrideEstimatedDelivery = null, overrideSalesman = null) {
    // 1. Fetch project details using jobNo as projectNo
    let projectSalesman = null;
    let projectRequestDelivery = null;
    try {
        const [projectRows] = await connection.execute(
            `SELECT salesman, requestedDelivery FROM projects WHERE projectNo = ?`,
            [jobNo]
        );
        if (projectRows.length > 0) {
            projectSalesman = projectRows[0].salesman;
            projectRequestDelivery = projectRows[0].requestedDelivery;
            console.log(`ℹ️ Found project ${jobNo}: salesman=${projectSalesman}, requestedDelivery=${projectRequestDelivery}`);
        } else {
            console.log(`ℹ️ No project found for job ${jobNo}, using defaults (null).`);
        }
    } catch (err) {
        console.error(`⚠️ Error fetching project details for ${jobNo}:`, err);
        // Continue with null values
    }

    // 2. Determine final values: override if provided, else use project defaults
    const finalSalesman = overrideSalesman !== null ? overrideSalesman : projectSalesman;
    const finalEstimatedDelivery = overrideEstimatedDelivery !== null ? overrideEstimatedDelivery : projectRequestDelivery;

    // 3. Check if a panel already exists for this job
    const [existing] = await connection.execute(
        `SELECT id FROM panels WHERE job_no = ?`,
        [jobNo]
    );

    if (existing.length > 0) {
        // ✅ UPDATE existing panel – status is always set to 'pending' on sign
        await connection.execute(
            `UPDATE panels 
             SET notes = ?, status = 'pending', estimated_delivery = ?, salesman = ?, updated_at = NOW()
             WHERE job_no = ?`,
            [remarks || null, finalEstimatedDelivery, finalSalesman, jobNo]
        );
        console.log(`🔄 Updated existing panels for job ${jobNo} (status → pending, salesman=${finalSalesman}, estimated_delivery=${finalEstimatedDelivery})`);
    } else {
        // Generate a new reference number in REF-YYMMDD-XXX format
        const refNumber = await generateReferenceNumber(connection);
        // Insert a new panel with default values – status = 'pending'
        await connection.execute(
            `INSERT INTO panels 
                (job_no, reference_number, notes, status, estimated_delivery, salesman, 
                 width, length, qty, balance, type, panel_thk, joint, surface_front, surface_back, 
                 surface_front_thk, surface_back_thk, surface_type, cutting, 
                 application, remaining_meter, created_at, updated_at) 
             VALUES (?, ?, ?, 'pending', ?, ?, 
                     0, 0, 0, 0, NULL, NULL, NULL, NULL, NULL, 
                     NULL, NULL, NULL, NULL, 
                     NULL, NULL, NOW(), NOW())`,
            [jobNo, refNumber, remarks || null, finalEstimatedDelivery, finalSalesman]
        );
        console.log(`✅ Created new panels for job ${jobNo} with ref ${refNumber} (status → pending, salesman=${finalSalesman}, estimated_delivery=${finalEstimatedDelivery})`);
    }
}

// ============================================================
// GET /api/admin/jobs - Fetch All Jobs
// ============================================================
router.get('/', async (req, res) => {
    const query = `SELECT * FROM ${TABLE_NAME} ORDER BY Date_Entry DESC`;
    try {
        const [results] = await pool.execute(query);
        res.json(results.map(formatJob));
    } catch (err) {
        console.error('Error fetching all jobs:', err);
        return res.status(500).json({ error: 'Failed to fetch job list' });
    }
});

// ============================================================
// GET /api/admin/jobs/:jobNo - Fetch Single Job
// ============================================================
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

// ============================================================
// POST /api/admin/jobs - Create Job
// ============================================================
router.post('/', async (req, res) => {
    const { 
        Date_Entry, 
        Job_No, 
        Customer_Name, 
        Sales_Amount, 
        Sell_Price, 
        Cost, 
        Margin, 
        Remarks,
        Signature_Data,
        estimated_delivery,
        salesman
    } = req.body;
    
    const TASK_TABLES = [
        'panel_tasks', 'cutting_tasks', 'door_tasks', 
        'strip_curtain_tasks', 'accessories_tasks', 'system_tasks', 
        'transportation_tasks', 'quotation_tasks'
    ];

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
    
    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        // ✅ CHECK: Prevent duplicate job numbers
        const [existing] = await connection.execute(`SELECT Job_No FROM ${TABLE_NAME} WHERE Job_No = ?`, [Job_No]);
        if (existing.length > 0) {
            await connection.rollback();
            return res.status(409).json({ error: `Job with Job No ${Job_No} already exists.` });
        }
        
        let signatureBuffer = null;
        let hasSignature = false;
        if (Signature_Data && Signature_Data.startsWith('data:image/')) {
            const base64Data = Signature_Data.replace(/^data:image\/\w+;base64,/, '');
            signatureBuffer = Buffer.from(base64Data, 'base64');
            hasSignature = true;
        }
        
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

        if (hasSignature) {
            // Update project status
            await connection.execute(
                `UPDATE projects SET status = 'Approved' WHERE projectNo = ?`,
                [Job_No]
            );
            console.log(`✅ Project ${Job_No} status updated to Approved.`);

            // Update all pending tasks
            const updatePromises = TASK_TABLES.map(table => {
                return connection.execute(
                    `UPDATE ${table} SET approve_status = 'approved' WHERE project_no = ? AND status = 'pending'`,
                    [Job_No]
                );
            });
            await Promise.all(updatePromises);
            console.log(`✅ All pending tasks for project ${Job_No} updated to 'approved'.`);
            statusUpdateMessage = `Job created, project status updated, and all pending category tasks set to 'approved'.`;

            // Create/update panels record – will set status to 'pending'
            await createOrUpdatepanelsForJob(
                connection,
                Job_No,
                Remarks,
                estimated_delivery || null,
                salesman || null
            );
        }

        await connection.commit();

        const [rows] = await pool.execute(`SELECT * FROM ${TABLE_NAME} WHERE Job_No = ?`, [Job_No]);
        res.status(201).json({
            job: rows[0] ? formatJob(rows[0]) : { Job_No },
            message: statusUpdateMessage
        });
        
    } catch (err) {
        if (connection) await connection.rollback();
        console.error('Error creating job:', err);
        return res.status(500).json({ error: 'Failed to create job or update associated statuses.' });
    } finally {
        if (connection) connection.release();
    }
});

// ============================================================
// PUT /api/admin/jobs/:jobNo - Update Job
// ============================================================
router.put('/:jobNo', async (req, res) => {
    const jobNo = req.params.jobNo;
    const updates = req.body;

    const RELATED_TABLES = [
        'panel_tasks', 'cutting_tasks', 'door_tasks', 
        'strip_curtain_tasks', 'accessories_tasks', 'system_tasks', 
        'transportation_tasks', 'quotation_tasks', 'project_files'
    ];

    const TABLE_COLUMN_MAP = {
        'panel_tasks': 'project_no',
        'cutting_tasks': 'project_no',
        'door_tasks': 'project_no',
        'strip_curtain_tasks': 'project_no',
        'accessories_tasks': 'project_no',
        'system_tasks': 'project_no',
        'transportation_tasks': 'project_no',
        'quotation_tasks': 'project_no',
        'project_files': 'projectNo'
    };

    const allowedFields = [
        'Job_No', 'Date_Entry', 'Customer_Name', 'Sales_Amount', 'Sell_Price', 
        'Cost', 'Margin', 'Remarks', 'Signature_Data',
        'estimated_delivery', 'salesman'
    ];

    const fieldsToUpdate = [];
    const updateValues = [];

    let hasNewSignature = false;
    let newJobNo = jobNo;
    let newRemarks = null;
    let newEstimatedDelivery = null;
    let newSalesman = null;

    for (const field of allowedFields) {
        if (updates[field] !== undefined) {
            fieldsToUpdate.push(`${field} = ?`);
            let value = updates[field];

            if (field === 'Signature_Data') {
                if (!value || value === '') {
                    value = null;
                } else if (typeof value === 'string' && value.startsWith('data:image/')) {
                    const base64Data = value.replace(/^data:image\/\w+;base64,/, '');
                    value = Buffer.from(base64Data, 'base64');
                    hasNewSignature = true;
                }
            } else if (field === 'Job_No') {
                newJobNo = value;
            } else if (field === 'Remarks') {
                newRemarks = value;
            } else if (field === 'estimated_delivery') {
                newEstimatedDelivery = value;
            } else if (field === 'salesman') {
                newSalesman = value;
            } else if (typeof value === 'string' && value.trim() === '' &&
                ['Customer_Name', 'Remarks'].includes(field)) {
                value = null;
            } else if (field === 'Margin' && (value === null || value === '')) {
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

    let connection;
    let statusUpdateMessage = '';

    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        const [result] = await connection.execute(updateSql, finalBindValues);
        if (result.affectedRows === 0) {
            await connection.rollback();
            return res.status(404).json({ error: `Job with Job No ${jobNo} not found.` });
        }

        if (newJobNo !== jobNo) {
            console.log(`🔄 Job number changed from ${jobNo} to ${newJobNo}. Updating related tables...`);
            const updatePromises = RELATED_TABLES.map(table => {
                const column = TABLE_COLUMN_MAP[table];
                return connection.execute(
                    `UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`,
                    [newJobNo, jobNo]
                );
            });
            updatePromises.push(
                connection.execute(
                    `UPDATE projects SET projectNo = ? WHERE projectNo = ?`,
                    [newJobNo, jobNo]
                )
            );
            await Promise.all(updatePromises);
            console.log(`✅ All related tables updated with new job number ${newJobNo}`);
            statusUpdateMessage = `Job updated and job number changed from ${jobNo} to ${newJobNo}.`;
        }

        const jobNoToUse = newJobNo !== jobNo ? newJobNo : jobNo;

        if (hasNewSignature) {
            const [projectRows] = await connection.execute(
                `SELECT status FROM projects WHERE projectNo = ?`,
                [jobNoToUse]
            );
            const currentStatus = projectRows[0]?.status;
            console.log(`ℹ️ Current project status for ${jobNoToUse}: ${currentStatus}`);

            if (currentStatus !== 'done' && currentStatus !== 'Completed') {
                await connection.execute(
                    `UPDATE projects SET status = 'Approved' WHERE projectNo = ?`,
                    [jobNoToUse]
                );
                console.log(`✅ Project ${jobNoToUse} status updated to Approved.`);

                const taskTables = RELATED_TABLES.filter(table => table !== 'project_files');
                const statusUpdatePromises = taskTables.map(table => {
                    return connection.execute(
                        `UPDATE ${table} 
                         SET approve_status = 'Approved' 
                         WHERE project_no = ? AND status = 'pending'`,
                        [jobNoToUse]
                    );
                });
                await Promise.all(statusUpdatePromises);
                console.log(`✅ All pending tasks for project ${jobNoToUse} updated to 'Approved'.`);
                statusUpdateMessage += ` Project status updated and all pending category tasks set to 'Approved'.`;
            } else {
                console.log(`⏭️ Skipping status update — project ${jobNoToUse} is already '${currentStatus}'.`);
                statusUpdateMessage += ` Signature saved. Project status unchanged (currently '${currentStatus}').`;
            }

            // ✅ Create/update panels – this will set status to 'pending'
            const finalRemarks = newRemarks !== null ? newRemarks : updates.Remarks || null;
            await createOrUpdatepanelsForJob(
                connection,
                jobNoToUse,
                finalRemarks,
                newEstimatedDelivery !== null ? newEstimatedDelivery : updates.estimated_delivery || null,
                newSalesman !== null ? newSalesman : updates.salesman || null
            );
        } else {
            statusUpdateMessage = statusUpdateMessage || `Job updated successfully.`;
        }

        await connection.commit();

        const [rows] = await pool.execute(
            `SELECT * FROM ${TABLE_NAME} WHERE Job_No = ?`,
            [jobNoToUse]
        );
        res.json({
            job: rows[0] ? formatJob(rows[0]) : { Job_No: jobNoToUse },
            message: statusUpdateMessage
        });

    } catch (err) {
        if (connection) await connection.rollback();
        console.error(`Error updating job ${jobNo}:`, err);
        return res.status(500).json({
            error: 'Failed to update job or associated tables.',
            details: err.message
        });
    } finally {
        if (connection) connection.release();
    }
});

// ============================================================
// DELETE /api/admin/jobs/:jobNo – Full Cleanup
// ============================================================
router.delete('/:jobNo', async (req, res) => {
    const rawJobNo = req.params.jobNo;
    const safeJobNo = rawJobNo.replace(/\//g, '_');

    const taskTables = [
        'panel_tasks', 'cutting_tasks', 'door_tasks',
        'strip_curtain_tasks', 'accessories_tasks',
        'system_tasks', 'transportation_tasks', 'quotation_tasks'
    ];

    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        // 1. Delete production_records linked to panels of this project
        const [prodResult] = await connection.execute(
            `DELETE pr FROM production_records pr
             JOIN panels pa ON pr.panel_id = pa.id
             WHERE pa.job_no = ?`,
            [safeJobNo]
        );
        console.log(`🗑️ Deleted ${prodResult.affectedRows} production_records for job ${safeJobNo}`);

        // 2. Delete all panels for this project
        const [panelsResult] = await connection.execute(
            `DELETE FROM panels WHERE job_no = ?`,
            [safeJobNo]
        );
        console.log(`🗑️ Deleted ${panelsResult.affectedRows} panels for job ${safeJobNo}`);

        // 3. Delete all category tasks
        let totalTasksDeleted = 0;
        for (const table of taskTables) {
            const [result] = await connection.execute(
                `DELETE FROM ${table} WHERE project_no = ?`,
                [safeJobNo]
            );
            totalTasksDeleted += result.affectedRows;
        }
        console.log(`🗑️ Deleted ${totalTasksDeleted} category tasks for job ${safeJobNo}`);

        // 4. Delete project files
        const [filesResult] = await connection.execute(
            `DELETE FROM project_files WHERE projectNo = ?`,
            [safeJobNo]
        );
        console.log(`🗑️ Deleted ${filesResult.affectedRows} project files for job ${safeJobNo}`);

        // 5. Delete the project itself
        const [projectResult] = await connection.execute(
            `DELETE FROM projects WHERE projectNo = ?`,
            [safeJobNo]
        );
        console.log(`🗑️ Deleted ${projectResult.affectedRows} project(s) for job ${safeJobNo}`);

        // 6. Delete the job ledger entry
        const [ledgerResult] = await connection.execute(
            `DELETE FROM job_ledger WHERE Job_No = ?`,
            [safeJobNo]
        );
        console.log(`🗑️ Deleted ${ledgerResult.affectedRows} job_ledger entry for job ${safeJobNo}`);

        if (ledgerResult.affectedRows === 0 && projectResult.affectedRows === 0) {
            await connection.rollback();
            return res.status(404).json({ error: `No records found for Job No: ${safeJobNo}` });
        }

        await connection.commit();
        res.status(200).json({
            message: `Job ${safeJobNo} and all associated data deleted successfully.`
        });

    } catch (err) {
        if (connection) {
            await connection.rollback();
            connection.release();
        }
        console.error(`Error deleting job ${safeJobNo}:`, err);
        return res.status(500).json({
            error: 'Failed to delete job and all associated data.',
            details: err.message
        });
    } finally {
        if (connection) connection.release();
    }
});

module.exports = router;