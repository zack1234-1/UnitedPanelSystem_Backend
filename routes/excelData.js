// routes/excelData.js
const express = require('express');
const router = express.Router();
const db = require('../db/connection');

router.post('/excel-data', async (req, res) => {
  try {
    const { data } = req.body;
    const tableName = 'excel_table';

    if (!data || !Array.isArray(data)) {
      return res.status(400).json({ error: 'Valid data array is required' });
    }

    const validColumns = [
      'NO', 'WIDTH', 'LENGTH (mm)', 'QTY (Pcs)', 'Thk', 'Surface', 'APPLICATION', 'REMARKS', 'BATCH'
    ];

    const keyMapping = {
      'LENGTH_mm': 'LENGTH (mm)',
      'QTY_Pcs': 'QTY (Pcs)',
      'LENGTH (mm)': 'LENGTH (mm)',
      'QTY (Pcs)': 'QTY (Pcs)'
    };

    // 3. CREATE TABLE
    const columnDefinitions = validColumns
      .map(col => `\`${col}\` TEXT NULL`)
      .join(', ');

    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS \`${tableName}\` (
        id INT(11) AUTO_INCREMENT PRIMARY KEY,
        ${columnDefinitions}
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `;

    await db.query(createTableQuery);

    // 4. INSERT DATA
    if (data.length > 0) {
      const columnNames = validColumns.map(col => `\`${col}\``).join(', ');
      const placeholders = validColumns.map(() => `?`).join(', ');
      const insertQuery = `INSERT INTO \`${tableName}\` (${columnNames}) VALUES (${placeholders})`;

      for (const row of data) {
        const values = validColumns.map(col => {
          // Find if any key in the 'row' maps to this 'col'
          const matchingKey = Object.keys(row).find(k => {
            const trimmedKey = k.trim();
            // Match if exact, or if it's a known mapped key (like LENGTH_mm -> LENGTH (mm))
            return trimmedKey === col || keyMapping[trimmedKey] === col;
          });

          const val = matchingKey ? row[matchingKey] : '';
          return (val === undefined || val === null || val === 'null') ? '' : val;
        });
        
        await db.query(insertQuery, values);
      }
    }

    res.status(201).json({ message: 'Data stored successfully', rowCount: data.length });

  } catch (error) {
    console.error('Database Error:', error);
    res.status(500).json({ error: 'Failed to store data', details: error.sqlMessage });
  }
});

// Get data from the table
router.get('/excel-tables', async (req, res) => {
  try {
    const tableName = 'excel_table';
    
    // Check if the table exists first to avoid SQL errors if it's empty
    const [rows] = await db.query(`SELECT * FROM \`${tableName}\` ORDER BY id`);
    
    // Extract columns from the first row if they exist, excluding 'id'
    const columns = rows.length > 0 
      ? Object.keys(rows[0]).filter(col => col !== 'id') 
      : [];

    // Log 'rows' (the correct variable name)
    console.log('Fetched rows:', rows.length);

    // Send the response ONCE
    return res.json({ data: rows, columns });

  } catch (error) {
    console.error('Error fetching data:', error);
    
    // Only send error if headers haven't been sent yet
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Failed to fetch data' });
    }
  }
});

// Delete Table
router.delete('/excel-data', async (req, res) => {
  try {
    await db.query(`DROP TABLE IF EXISTS excel_table`);
    res.json({ message: 'Table excel_table deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete table' });
  }
});

module.exports = router;
