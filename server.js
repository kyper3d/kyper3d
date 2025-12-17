import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import mysql from 'mysql2/promise'

dotenv.config()

const app = express()
const PORT = process.env.PORT || 3000

// Middleware
app.use(cors())
app.use(express.json())

// Database Connection Pool
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'kyper_shop',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
})

// Test Route
app.get('/api/health', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT 1 + 1 AS solution')
        res.json({ status: 'ok', db_check: rows[0].solution === 2 })
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message })
    }
})

// --- API ROUTES ---

// --- API ROUTES ---

// 1. PRODUCTS Routes
app.get('/api/products', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM products ORDER BY created_at DESC')
        res.json(rows)
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.get('/api/products/:id', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM products WHERE id = ?', [req.params.id])
        if (rows.length === 0) return res.status(404).json({ error: 'Product not found' })
        res.json(rows[0])
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.post('/api/products', async (req, res) => {
    const { name_es, name_en, price, stock, image, category, description_es, description_en } = req.body
    try {
        const [result] = await pool.query(
            `INSERT INTO products (name_es, name_en, price, stock, image, category, description_es, description_en) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [name_es, name_en, price, stock, image, category, description_es, description_en]
        )
        res.json({ id: result.insertId, ...req.body })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.delete('/api/products/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM products WHERE id = ?', [req.params.id])
        res.json({ message: 'Product deleted' })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})


// 2. ORDERS Routes
app.get('/api/orders', async (req, res) => {
    try {
        // Fetch orders with user details if possible (JOIN)
        const [rows] = await pool.query(`
            SELECT o.*, u.email as user_email, u.name as user_name 
            FROM orders o 
            LEFT JOIN users u ON o.user_id = u.id 
            ORDER BY o.created_at DESC
        `)

        // For each order, get items (this is N+1 but simple for now, or use JSON_ARRAYAGG if MySQL 5.7+)
        for (let order of rows) {
            const [items] = await pool.query('SELECT * FROM order_items WHERE order_id = ?', [order.id])
            order.items = items
        }

        res.json(rows)
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.post('/api/orders', async (req, res) => {
    const connection = await pool.getConnection()
    try {
        await connection.beginTransaction()

        const { user_id, total, shipping_address, items, status } = req.body

        // 1. Create Order
        const [orderResult] = await connection.query(
            'INSERT INTO orders (user_id, total, shipping_address, status) VALUES (?, ?, ?, ?)',
            [user_id || null, total, JSON.stringify(shipping_address), status || 'pending']
        )
        const orderId = orderResult.insertId

        // 2. Create Order Items
        for (const item of items) {
            await connection.query(
                'INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase) VALUES (?, ?, ?, ?)',
                [orderId, item.id, item.quantity, item.price]
            )

            // 3. Update Stock (Optional but recommended)
            await connection.query('UPDATE products SET stock = stock - ? WHERE id = ?', [item.quantity, item.id])
        }

        await connection.commit()
        res.json({ id: orderId, message: 'Order created successfully' })

    } catch (error) {
        await connection.rollback()
        res.status(500).json({ error: error.message })
    } finally {
        connection.release()
    }
})


// 3. BRANDS Routes
// GET All Brands
app.get('/api/brands', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM brands ORDER BY created_at DESC')
        res.json(rows)
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

// POST Create Brand
app.post('/api/brands', async (req, res) => {
    const { name, color, image } = req.body
    try {
        const [result] = await pool.query(
            'INSERT INTO brands (name, color, image) VALUES (?, ?, ?)',
            [name, color, image]
        )
        res.json({ id: result.insertId, name, color, image })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

// DELETE Brand
app.delete('/api/brands/:id', async (req, res) => {
    const { id } = req.params
    try {
        await pool.query('DELETE FROM brands WHERE id = ?', [id])
        res.json({ message: 'Brand deleted' })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})


// 4. USERS Routes
app.post('/api/users/register', async (req, res) => {
    const { name, email, password } = req.body
    try {
        // Check if exists
        const [exists] = await pool.query('SELECT id FROM users WHERE email = ?', [email])
        if (exists.length > 0) return res.status(400).json({ error: 'Email already exists' })

        const [result] = await pool.query(
            'INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)',
            [name, email, password, 'user'] // Password should be hashed in production!
        )
        res.json({ id: result.insertId, name, email, role: 'user', points: 0 })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.post('/api/users/login', async (req, res) => {
    const { email, password } = req.body
    try {
        const [rows] = await pool.query('SELECT * FROM users WHERE email = ? AND password = ?', [email, password])
        if (rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' })

        const user = rows[0]
        res.json({
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role,
            points: user.points
        })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.get('/api/users', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT id, name, email, role, points, created_at FROM users')
        res.json(rows)
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

// 4. USERS Routes (Previous routes remain...)
// ... (Your existing routes here)

// --- API ONLY MODE ---
// The frontend will be hosted separately (e.g., Hostinger public_html)
// This server only handles data (JSON)

app.get('/', (req, res) => {
    res.send('Kyper3D API is running correctly.')
})

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`)
})
