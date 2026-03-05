const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(cors());          // <--- Sin esto, el navegador bloquea el botón
app.use(express.json());

// --- CONEXIÓN A BASE DE DATOS ---
const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'contable-test',
    password: '123456', // Asegúrate que esta sea tu clave correcta
    port: 5432,
});

// --- API SIMULADA DE TASA BCV ---
app.get('/api/rate', (req, res) => {
    setTimeout(() => { res.json({ rate: 64.25 }); }, 500);
});

// --- 1. LOGIN ---
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    // Nota: El frontend envía el rol (ej. 'control_panel') como el campo 'username'

    try {
        // Buscamos el usuario en la tabla 'users' que coincida con el rol e identificador
        const userRes = await pool.query(
            "SELECT id, username, role FROM users WHERE username = $1 AND password = $2",
            [username, password]
        );

        if (userRes.rows.length === 0) {
            return res.status(401).json({
                error: 'Credenciales incorrectas para este perfil de acceso'
            });
        }

        const user = userRes.rows[0];

        // Respondemos con los datos necesarios para el contexto de AuthContext
        res.json({
            user: {
                id: user.id,
                username: user.username,
                role: user.role
            }
        });

    } catch (err) {
        console.error("ERROR EN LOGIN:", err.message);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// --- 2. LISTAR EMPRESAS ---
app.get('/api/companies', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM companies ORDER BY id");
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).send("Error DB");
    }
});

// --- 3. BUSCADOR DE CUENTAS ---
app.get('/api/accounts', async (req, res) => {
    const { search } = req.query;
    try {
        const result = await pool.query(
            "SELECT * FROM accounts WHERE code ILIKE $1 OR name ILIKE $1 LIMIT 20",
            [`%${search}%`]
        );
        res.json(result.rows);
    } catch (err) { res.status(500).send("Error DB"); }
});

// --- 4. BUSCAR PROVEEDOR ---
app.get('/api/providers/:code', async (req, res) => {
    const { code } = req.params;
    const { companyId } = req.query;
    try {
        const result = await pool.query(
            "SELECT * FROM providers WHERE code = $1 AND company_id = $2",
            [code, companyId]
        );
        if (result.rows.length > 0) res.json(result.rows[0]);
        else res.status(404).json({ message: 'Proveedor no encontrado' });
    } catch (err) { res.status(500).send("Error"); }
});

// --- 5. CREAR PROVEEDOR ---
app.post('/api/providers', async (req, res) => {
    const {
        code, name, rif, providerType, origin, deducibility,
        nonDeductible, purchaseAccount, payableAccount, companyId
    } = req.body;

    try {
        const result = await pool.query(
            `INSERT INTO providers 
            (code, name, rif, type, origin, deducibility, non_deductible, purchase_account, payable_account, company_id) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
            [code, name, rif, providerType, origin, deducibility, nonDeductible, purchaseAccount, payableAccount, companyId]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al guardar proveedor' });
    }
});

// --- NUEVO: BUSCAR PROVEEDORES EN TIEMPO REAL ---
app.get('/api/providers-search', async (req, res) => {
    // Aceptamos cualquier forma en que se envíe el ID
    const { term, companyId, company_id } = req.query;
    const finalId = companyId || company_id;

    try {
        let queryText = `
            SELECT p.*, c.name as company_name 
            FROM providers p
            LEFT JOIN companies c ON p.company_id = c.id
            WHERE (p.code ILIKE $1 OR p.name ILIKE $1)
        `;
        let params = [`%${term || ''}%`];

        // Si hay ID (Dashboard), filtra. Si no hay ID (Panel Maestro), trae todo.
        if (finalId && finalId !== 'undefined' && finalId !== '') {
            queryText += " AND p.company_id = $2";
            params.push(finalId);
        }

        queryText += " ORDER BY p.name ASC LIMIT 50";
        const result = await pool.query(queryText, params);
        res.json(result.rows);
    } catch (err) {
        console.error("Error en proveedores:", err);
        res.status(500).json({ error: "Error de servidor" });
    }
});

// --- 6. GUARDAR COMPRA (CON VALIDACIÓN DE DUPLICADOS) ---
app.post('/api/purchases', async (req, res) => {
    try {
        const { companyId, date, type, ref, controlNumber, status, isAsset, providerCode, providerName, beneficiaryName, beneficiaryId, totalUSD, totalVES, taxAmountUSD, inputCurrency } = req.body;

        // VALIDACIÓN: rows para acceder a los datos
        const checkRefGlobal = await pool.query(
            "SELECT id, provider_name FROM purchases WHERE company_id = $1 AND reference = $2",
            [companyId, ref]
        );

        if (checkRefGlobal.rows.length > 0) {
            return res.status(400).json({
                error: `El documento N° ${ref} ya existe (Registrado por: ${checkRefGlobal.rows.provider_name}).`
            });
        }

        const newPurchase = await pool.query(
            `INSERT INTO purchases (company_id, date, registration_date, type, reference, control, status, is_asset, provider_code, provider_name, beneficiary_name, beneficiary_id, total_usd, total_bs, tax_amount_usd, input_currency) 
            VALUES ($1, $2, CURRENT_DATE, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
            [companyId, date, type, ref, controlNumber, status, isAsset, providerCode, providerName, beneficiaryName, beneficiaryId, totalUSD, totalVES, taxAmountUSD, inputCurrency || 'USD']
        );
        res.json(newPurchase.rows); // Retornar objeto único
    } catch (err) { res.status(500).json({ error: "Error de servidor" }); }
});


// --- 7. LISTAR COMPRAS (CON BUSCADOR) ---
app.get('/api/purchases', async (req, res) => {
    // Recibimos 'providerName' para el detalle del reporte
    const { companyId, search, month, year, providerName } = req.query;

    try {
        let queryText = `
            SELECT 
                p.*, 
                COALESCE(NULLIF(p.provider_name, ''), pr.name) as provider_name, 
                COALESCE(NULLIF(p.provider_code, ''), pr.code) as provider_code,
                pr.rif as provider_rif
            FROM purchases p
            /* CORRECCIÓN DE DUPLICADOS: Unimos por código Y por empresa específica */
            LEFT JOIN providers pr ON p.provider_code = pr.code AND p.company_id = pr.company_id
            WHERE p.company_id = $1
        `;

        const queryParams = [companyId];

        // CORRECCIÓN PARA ENERO: Filtramos por 'p.date' (fecha de emisión) 
        // para que coincida con lo que ves en el reporte agrupado.
        if (month && year) {
            queryText += ` AND EXTRACT(MONTH FROM p.registration_date) = $${queryParams.length + 1}`;
            queryParams.push(month);
            queryText += ` AND EXTRACT(YEAR FROM p.registration_date) = $${queryParams.length + 1}`;
            queryParams.push(year);
        }

        // FILTRO POR PROVEEDOR (Para el modal de detalles)
        if (providerName) {
            // CAMBIO: Filtramos por el nombre resultante (Beneficiario > Proveedor)
            // Esto asegura que si una factura de ZOOM se le pagó a Sebastian, 
            // solo aparezca en el detalle de Sebastian.
            queryText += ` AND (COALESCE(NULLIF(p.beneficiary_name, ''), p.provider_name, 'Sin Nombre') = $${queryParams.length + 1})`;
            queryParams.push(providerName);
        }

        // LÓGICA DEL BUSCADOR
        if (search) {
            queryText += `
                AND (
                    p.reference ILIKE $${queryParams.length + 1} OR
                    p.beneficiary_name ILIKE $${queryParams.length + 1} OR
                    p.provider_name ILIKE $${queryParams.length + 1} OR
                    pr.name ILIKE $${queryParams.length + 1}
                )
            `;
            queryParams.push(`%${search}%`);
        }

        // Ordenamos por el ID más reciente para que lo último que registres salga arriba
        queryText += ` ORDER BY p.id DESC`;

        const result = await pool.query(queryText, queryParams);
        res.json(result.rows);

    } catch (err) {
        console.error("Error en compras:", err);
        res.status(500).json({ error: "Error al listar compras" });
    }
});

// --- 8. ELIMINAR COMPRA ---
app.delete('/api/purchases/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query("DELETE FROM purchases WHERE id = $1", [id]);
        res.json({ message: 'Eliminado correctamente' });
    } catch (err) { res.status(500).json({ error: 'No se pudo eliminar' }); }
});

// --- 9. DASHBOARD RESUMEN (DASHBOARD PRINCIPAL) ---
app.get('/api/dashboard-summary', async (req, res) => {
    // Recibimos month y year desde los selectores globales del Dashboard
    const { companyId, month, year } = req.query;
    const params = [companyId, month, year];

    try {
        const parse = (val) => parseFloat(val || 0);

        // 1. COMPRAS (Egresos, Cuentas por Pagar, Impuestos, Activos) - Filtrados por Mes/Año
        const expensesRes = await pool.query(`
            SELECT SUM(total_usd) as usd, SUM(total_bs) as bs 
            FROM purchases 
            WHERE company_id = $1 AND is_asset = false
            AND EXTRACT(MONTH FROM registration_date) = $2
            AND EXTRACT(YEAR FROM registration_date) = $3
        `, params);

        const taxesRes = await pool.query(`
            SELECT 
                SUM(tax_amount_usd) as usd, 
                SUM(tax_amount_usd * COALESCE(exchange_rate, CASE WHEN total_usd > 0 THEN (total_bs / total_usd) ELSE 1 END)) as bs 
            FROM purchases 
            WHERE company_id = $1
            AND EXTRACT(MONTH FROM registration_date) = $2
            AND EXTRACT(YEAR FROM registration_date) = $3
        `, params);

        const payablesRes = await pool.query(`
            SELECT SUM(total_usd) as usd, SUM(total_bs) as bs 
            FROM purchases 
            WHERE company_id = $1 AND status = 'pending'
            AND EXTRACT(MONTH FROM registration_date) = $2
            AND EXTRACT(YEAR FROM registration_date) = $3
        `, params);

        const assetsRes = await pool.query(`
            SELECT SUM(total_usd) as usd, SUM(total_bs) as bs 
            FROM purchases 
            WHERE company_id = $1 AND is_asset = true
            AND EXTRACT(MONTH FROM registration_date) = $2
            AND EXTRACT(YEAR FROM registration_date) = $3
        `, params);

        // 2. VENTAS (Ingresos y Cuentas por Cobrar) - Filtrados por Mes/Año
        const incomeRes = await pool.query(`
            SELECT SUM(total_usd) as usd, SUM(total_bs) as bs 
            FROM sales 
            WHERE company_id = $1 AND is_asset = false
            AND EXTRACT(MONTH FROM registration_date) = $2
            AND EXTRACT(YEAR FROM registration_date) = $3
        `, params);

        const receivablesRes = await pool.query(`
            SELECT SUM(total_usd) as usd, SUM(total_bs) as bs 
            FROM sales 
            WHERE company_id = $1 AND status = 'pending'
            AND EXTRACT(MONTH FROM registration_date) = $2
            AND EXTRACT(YEAR FROM registration_date) = $3
        `, params);

        // 3. MOVIMIENTOS RECIENTES (También filtrados al mes seleccionado para que cuadre)
        const recentRes = await pool.query(`
            (SELECT id, registration_date as date, 'Venta' as type, status, total_usd, total_bs, client_name as display_name 
             FROM sales 
             WHERE company_id = $1 AND EXTRACT(MONTH FROM registration_date) = $2 AND EXTRACT(YEAR FROM registration_date) = $3)
            UNION ALL
            (SELECT id, registration_date as date, 'Compra' as type, status, total_usd, total_bs, provider_name as display_name 
             FROM purchases 
             WHERE company_id = $1 AND EXTRACT(MONTH FROM registration_date) = $2 AND EXTRACT(YEAR FROM registration_date) = $3)
            ORDER BY date DESC LIMIT 5
        `, params);

        const data = {
            usd: {
                income: parse(incomeRes.rows[0].usd),
                expenses: parse(expensesRes.rows[0].usd),
                taxes: parse(taxesRes.rows[0].usd),
                payables: parse(payablesRes.rows[0].usd),
                receivables: parse(receivablesRes.rows[0].usd),
                assets: parse(assetsRes.rows[0].usd),
                profit: parse(incomeRes.rows[0].usd) - parse(expensesRes.rows[0].usd)
            },
            bs: {
                income: parse(incomeRes.rows[0].bs),
                expenses: parse(expensesRes.rows[0].bs),
                taxes: parse(taxesRes.rows[0].bs),
                payables: parse(payablesRes.rows[0].bs),
                receivables: parse(receivablesRes.rows[0].bs),
                assets: parse(assetsRes.rows[0].bs),
                profit: parse(incomeRes.rows[0].bs) - parse(expensesRes.rows[0].bs)
            },
            recent: recentRes.rows
        };

        res.json(data);
    } catch (err) {
        console.error("Error calculando dashboard:", err);
        res.status(500).send("Error calculando dashboard");
    }
});


// --- 10. REPORTE DETALLADO (CORREGIDO: FILTRO POR REGISTRO) ---
app.get('/api/reports/grouped', async (req, res) => {
    const { companyId, type, month, year } = req.query;

    try {
        let query = "";

        // LÓGICA PARA VENTAS (Ingresos y Cuentas por Cobrar)
        if (type === 'income' || type === 'receivables') {
            const statusFilter = type === 'receivables' ? "AND status = 'pending'" : "";
            query = `
                SELECT 
                    client_name as name,
                    client_rif as rif,
                    COUNT(*) as count,
                    SUM(total_usd) as total_usd,
                    SUM(total_bs) as total_bs,
                    SUM(tax_amount_usd) as total_tax_usd
                FROM sales
                WHERE company_id = $1 
                  ${statusFilter}
                  AND EXTRACT(MONTH FROM registration_date) = $2 
                  AND EXTRACT(YEAR FROM registration_date) = $3
                GROUP BY client_name, client_rif
                ORDER BY total_usd DESC
            `;
        }
        // LÓGICA EXISTENTE PARA COMPRAS (Expenses, Payables, etc.)
        else {
            let whereClause = "";
            if (type === 'expenses') whereClause = "AND p.is_asset = false";
            else if (type === 'payables') whereClause = "AND p.status = 'pending'";
            else if (type === 'taxes') whereClause = "AND p.tax_amount_usd > 0";
            else if (type === 'assets') whereClause = "AND p.is_asset = true";

            query = `
                SELECT 
                    COALESCE(NULLIF(p.beneficiary_name, ''), p.provider_name, 'Sin Nombre') as name,
                    COALESCE(NULLIF(p.beneficiary_id, ''), pr.rif, 'S/R') as rif,
                    COUNT(*) as count,
                    SUM(p.total_usd) as total_usd,
                    SUM(p.total_bs) as total_bs,
                    SUM(p.tax_amount_usd) as total_tax_usd
                FROM purchases p
                LEFT JOIN providers pr ON p.provider_code = pr.code AND p.company_id = pr.company_id
                WHERE p.company_id = $1 
                  ${whereClause}
                  AND EXTRACT(MONTH FROM p.registration_date) = $2 
                  AND EXTRACT(YEAR FROM p.registration_date) = $3
                GROUP BY 1, 2 ORDER BY total_usd DESC
            `;
        }

        const result = await pool.query(query, [companyId, month, year]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).send("Error generando reporte");
    }
});

// --- 11. ACTUALIZAR ESTADO DE PAGO (NUEVO) ---
app.put('/api/purchases/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body; // Recibimos el nuevo estado ('paid')

    try {
        // Validación de seguridad simple
        if (!['paid', 'pending'].includes(status)) {
            return res.status(400).json({ error: "Estado no permitido" });
        }

        // Ejecutamos la actualización en la BD
        const result = await pool.query(
            "UPDATE purchases SET status = $1 WHERE id = $2 RETURNING *",
            [status, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Compra no encontrada" });
        }

        // Respondemos con éxito
        res.json({
            message: "Estado actualizado correctamente",
            purchase: result.rows[0]
        });

    } catch (err) {
        console.error("Error actualizando estado:", err);
        res.status(500).json({ error: "Error interno del servidor" });
    }
});

// --- ACTUALIZACIÓN: BUSCADOR DE CUENTAS EN TIEMPO REAL ---
app.get('/api/accounts-search', async (req, res) => {
    const { term, type } = req.query;
    try {
        let queryText = `
            SELECT code, name, type 
            FROM accounts 
            WHERE (code ILIKE $1 OR name ILIKE $1)
        `;
        const queryParams = [`%${term || ''}%`];

        if (type) {
            queryText += ` AND type = $2`;
            queryParams.push(type);
        }

        queryText += ` ORDER BY code ASC LIMIT 20`;
        const result = await pool.query(queryText, queryParams);
        res.json(result.rows);
    } catch (err) {
        console.error("Error en búsqueda global:", err);
        res.status(500).send("Error buscando cuentas");
    }
});

// --- NUEVO: REGISTRAR NUEVA CUENTA DE GASTO ---
// index.js (Backend)
app.post('/api/accounts', async (req, res) => {
    const { code, name, type } = req.body;

    try {
        // 1. VERIFICACIÓN: Buscar si el código ya existe en el catálogo global
        const checkRes = await pool.query(
            "SELECT code, name FROM accounts WHERE code = $1",
            [code]
        );

        if (checkRes.rows.length > 0) {
            const cuentaExistente = checkRes.rows;
            return res.status(400).json({
                error: `El código ${code} ya está registrado como '${cuentaExistente.name}'. No se permiten códigos duplicados.`
            });
        }

        // 2. INSERCIÓN GLOBAL
        const result = await pool.query(
            `INSERT INTO accounts (code, name, type) 
             VALUES ($1, $2, $3) 
             RETURNING *`,
            [code, name, type || 'Gasto']
        );
        res.json(result.rows);
    } catch (err) {
        console.error("ERROR AL GUARDAR CUENTA:", err.message);
        res.status(500).json({ error: "Error de base de datos al procesar la cuenta contable." });
    }
});
// VENTAS

// --- MODULO DE VENTAS Y CLIENTES ---

// 1. Buscador de Clientes en tiempo real
app.get('/api/clients-search', async (req, res) => {
    const { term, companyId, company_id } = req.query;
    const finalId = companyId || company_id;

    try {
        let queryText = `
            SELECT cl.*, c.name as company_name 
            FROM clients cl
            LEFT JOIN companies c ON cl.company_id = c.id
            WHERE (cl.code ILIKE $1 OR cl.name ILIKE $1 OR cl.rif ILIKE $1)
        `;
        let params = [`%${term || ''}%`];

        if (finalId && finalId !== 'undefined' && finalId !== '') {
            queryText += " AND cl.company_id = $2";
            params.push(finalId);
        }

        queryText += " ORDER BY cl.name ASC LIMIT 50";
        const result = await pool.query(queryText, params);
        res.json(result.rows);
    } catch (err) {
        console.error("Error en clientes:", err);
        res.status(500).json({ error: "Error de servidor" });
    }
});

// 2. Registrar nuevo Cliente
app.post('/api/clients', async (req, res) => {
    const {
        companyId, code, name, rif, destination,
        isContributor, isWithholdingAgent, receivableAccount, salesAccount
    } = req.body;
    try {
        const result = await pool.query(
            `INSERT INTO clients (
                company_id, code, name, rif, destination, 
                is_contributor, is_withholding_agent, receivable_account, sales_account
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
            [companyId, code, name, rif, destination, isContributor, isWithholdingAgent, receivableAccount, salesAccount]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: "Error al registrar cliente. ¿Código duplicado?" });
    }
});

// 3. Listar Ventas (Filtro por registro como en Compras)
app.get('/api/sales', async (req, res) => {
    const { companyId, month, year, search } = req.query;
    try {
        let queryText = `
            SELECT s.*, c.name as client_db_name
            FROM sales s
            LEFT JOIN clients c ON s.client_code = c.code AND s.company_id = c.company_id
            WHERE s.company_id = $1
        `;
        const queryParams = [companyId];

        if (month && year) {
            queryText += ` AND EXTRACT(MONTH FROM s.registration_date) = $${queryParams.length + 1}`;
            queryParams.push(month);
            queryText += ` AND EXTRACT(YEAR FROM s.registration_date) = $${queryParams.length + 1}`;
            queryParams.push(year);
        }

        if (search) {
            queryText += `
                AND (
                    s.reference ILIKE $${queryParams.length + 1} OR
                    s.client_name ILIKE $${queryParams.length + 1} OR
                    s.client_rif ILIKE $${queryParams.length + 1}
                )
            `;
            queryParams.push(`%${search}%`);
        }

        queryText += ` ORDER BY s.id DESC`;
        const result = await pool.query(queryText, queryParams);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: "Error al listar ventas" });
    }
});


// --- REGISTRAR VENTA (CON VALIDACIÓN DE DUPLICADOS) ---
app.post('/api/sales', async (req, res) => {
    try {
        const {
            companyId, date, type, ref, controlNumber,
            clientName, rif, clientCode,
            totalUSD, totalVES, exchangeRate,
            taxAmountUSD, status, isAsset, inputCurrency,
            beneficiaryName, beneficiaryId
        } = req.body;

        const docType = type || 'Factura';

        // 1. VALIDACIÓN: Evitar N° de Referencia duplicado en la MISMA EMPRESA
        const checkRef = await pool.query(
            "SELECT id FROM sales WHERE company_id = $1 AND doc_type = $2 AND reference = $3",
            [companyId, docType, ref]
        );
        if (checkRef.rows.length > 0) {
            return res.status(400).json({ error: `Ya emitiste un documento tipo '${docType}' con el Número: ${ref}.` });
        }

        // 2. VALIDACIÓN: Evitar N° de Control duplicado en la MISMA EMPRESA
        if (controlNumber && controlNumber.trim() !== '') {
            const checkCtrl = await pool.query(
                "SELECT id FROM sales WHERE company_id = $1 AND control_number = $2",
                [companyId, controlNumber]
            );
            if (checkCtrl.rows.length > 0) {
                return res.status(400).json({ error: `El Número de Control Fiscal '${controlNumber}' ya fue utilizado en otra venta.` });
            }
        }

        const result = await pool.query(
            `INSERT INTO sales (
                company_id, date, registration_date, doc_type, reference, 
                control_number, client_name, client_rif, client_code, 
                base_16, tax_amount_usd, total_usd, total_bs, exchange_rate,
                status, is_asset, input_currency, beneficiary_name, beneficiary_id
            ) 
            VALUES ($1, $2, CURRENT_DATE, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) 
            RETURNING *`,
            [
                companyId, date, docType, ref, controlNumber, clientName, rif, clientCode,
                0, taxAmountUSD || 0, totalUSD, totalVES, exchangeRate,
                status || 'paid', isAsset || false, inputCurrency || 'USD',
                beneficiaryName, beneficiaryId
            ]
        );
        return res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error("ERROR AL GUARDAR VENTA:", err.message);
        return res.status(500).json({ error: "Error interno al procesar la venta" });
    }
});

// --- ELIMINAR VENTA ---
app.delete('/api/sales/:id', async (req, res) => {
    const { id } = req.params;
    try {
        // Ejecutamos la eliminación en la tabla sales
        const result = await pool.query("DELETE FROM sales WHERE id = $1", [id]);

        if (result.rowCount === 0) {
            return res.status(404).json({ error: "Venta no encontrada" });
        }

        console.log(`Venta con ID ${id} eliminada correctamente`);
        res.json({ message: 'Venta eliminada correctamente' });
    } catch (err) {
        console.error("Error al eliminar venta:", err.message);
        res.status(500).json({ error: 'No se pudo eliminar la venta en la base de datos' });
    }
});


// --- ACTUALIZAR ESTADO DE COBRO (VENTAS) ---
app.put('/api/sales/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body; // Recibimos 'paid' desde el frontend

    try {
        // Validamos que el estado sea correcto
        if (status !== 'paid') {
            return res.status(400).json({ error: "Estado no válido" });
        }

        // Actualizamos la columna 'status' en la tabla sales
        const result = await pool.query(
            "UPDATE sales SET status = $1 WHERE id = $2 RETURNING *",
            [status, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Venta no encontrada" });
        }

        console.log(`Venta ID ${id} marcada como COBRADA ✅`);
        res.json({ message: "Cobro registrado con éxito", sale: result.rows[0] });

    } catch (err) {
        console.error("Error al actualizar cobro:", err.message);
        res.status(500).json({ error: "Error interno al procesar el cobro" });
    }
});

// Para obtener un cliente específico (GET)
// index.js (Backend)
app.get('/api/clients/:id', async (req, res) => {
    const { id } = req.params;
    const { companyId } = req.query;
    try {
        const result = await pool.query(
            'SELECT * FROM clients WHERE id = $1 AND company_id = $2',
            [id, companyId]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: "No existe" });
        res.json(result.rows[0]);
    } catch (err) { res.status(500).send("Error"); }
});





// --- NUEVAS RUTAS PARA EL PANEL MAESTRO (SUPER ADMIN) ---

// Gestión de Empresas
app.post('/api/admin/companies', async (req, res) => {
    const { name, rif } = req.body;
    try {
        const result = await pool.query(
            "INSERT INTO companies (name, rif) VALUES ($1, $2) RETURNING *",
            [name, rif]
        );
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: "Error al crear empresa" }); }
});

app.delete('/api/admin/companies/:id', async (req, res) => {
    try {
        await pool.query("DELETE FROM companies WHERE id = $1", [req.params.id]);
        res.json({ message: "Empresa eliminada" });
    } catch (err) {
        res.status(500).json({ error: "No se puede eliminar: tiene datos vinculados" });
    }
});

// Gestión de Cuentas (Nota: En tu BD el PK es 'code')
app.delete('/api/admin/accounts/:code', async (req, res) => {
    try {
        const { code } = req.params;
        const result = await pool.query("DELETE FROM accounts WHERE code = $1", [code]);

        if (result.rowCount === 0) {
            return res.status(404).json({ error: "La cuenta no existe" });
        }

        res.json({ message: "Cuenta contable eliminada del catálogo global" });
    } catch (err) {
        res.status(500).json({ error: "No se puede eliminar: esta cuenta está siendo usada por clientes o proveedores." });
    }
});

// Gestión de Clientes y Proveedores
app.delete('/api/admin/providers/:id', async (req, res) => {
    try {
        await pool.query("DELETE FROM providers WHERE id = $1", [req.params.id]);
        res.json({ message: "Proveedor eliminado" });
    } catch (err) { res.status(500).json({ error: "Error al borrar proveedor" }); }
});

app.delete('/api/admin/clients/:id', async (req, res) => {
    try {
        await pool.query("DELETE FROM clients WHERE id = $1", [req.params.id]);
        res.json({ message: "Cliente eliminado" });
    } catch (err) { res.status(500).json({ error: "Error al borrar cliente" }); }
});


// --- BUSCADORES CON JOIN PARA EL PANEL DE CONTROL ---

app.get('/api/accounts-search', async (req, res) => {
    const { term, type } = req.query;
    try {
        let queryText = `
            SELECT a.*, c.name as company_name 
            FROM accounts a
            LEFT JOIN companies c ON a.company_id = c.id
            WHERE (a.code ILIKE $1 OR a.name ILIKE $1)
        `;
        const queryParams = [`%${term}%` || '%%'];
        if (type) {
            queryText += ` AND a.type = $2`;
            queryParams.push(type);
        }
        queryText += ` ORDER BY a.code ASC LIMIT 50`;
        const result = await pool.query(queryText, queryParams);
        res.json(result.rows);
    } catch (err) { res.status(500).send("Error"); }
});

// --- BUSCADOR DE PROVEEDORES ACTUALIZADO ---
app.get('/api/providers-search', async (req, res) => {
    const { term, companyId } = req.query;
    try {
        // Hacemos un JOIN con companies para traer el nombre real
        let queryText = `
            SELECT p.*, c.name as company_name 
            FROM providers p
            LEFT JOIN companies c ON p.company_id = c.id
            WHERE (p.code ILIKE $1 OR p.name ILIKE $1)
        `;
        let params = [`%${term}%` || '%%'];

        // Si viene companyId (Dashboard), filtramos. Si no (Panel Maestro), traemos todo.
        if (companyId) {
            queryText += " AND p.company_id = $2";
            params.push(companyId);
        }

        queryText += " ORDER BY p.name ASC LIMIT 50";
        const result = await pool.query(queryText, params);
        res.json(result.rows);
    } catch (err) { res.status(500).send("Error buscando proveedores"); }
});

// --- BUSCADOR DE CLIENTES ACTUALIZADO ---



// =========================================================================
// MÓDULO DE REPORTES DETALLADOS (Ventas, Compras, CxC, CxP)
// =========================================================================
app.get('/api/reports/detailed', async (req, res) => {
    const { companyId, type, startDate, endDate, docType, entity } = req.query;

    try {
        let params = [companyId];
        let paramIdx = 2;
        let dateFilter = "";
        if (startDate) { dateFilter += ` AND registration_date >= $${paramIdx++}`; params.push(startDate); }
        if (endDate) { dateFilter += ` AND registration_date <= $${paramIdx++}`; params.push(endDate); }

        let query = "";

        // VENTAS Y CXC
        if (type === 'ventas' || type === 'cxc') {
            let statusF = type === 'cxc' ? " AND s.status = 'pending'" : "";
            query = `
                SELECT 
                    s.date, s.doc_type, s.reference, s.client_name as entity_name, 
                    s.client_rif as entity_rif, COALESCE(s.client_code, 'S/C') as account_code,
                    acc.name as category_name, -- NOMBRE DE LA CUENTA
                    (s.total_usd - s.tax_amount_usd) as monto, s.tax_amount_usd as iva, s.total_usd as total 
                FROM sales s
                LEFT JOIN clients c ON s.client_code = c.code AND s.company_id = c.company_id
                LEFT JOIN accounts acc ON c.sales_account = acc.code
                WHERE s.company_id = $1 ${statusF} 
                ${dateFilter.replace(/registration_date/g, 's.registration_date')}
                ORDER BY account_code ASC`;
        } 
        // COMPRAS, CXP Y ORDENES
        else {
            let typeF = type === 'ordenes' ? " AND p.type = 'Orden de pago'" : (type === 'cxp' ? " AND p.status = 'pending' AND p.type != 'Orden de pago'" : " AND p.type != 'Orden de pago'");
            query = `
                SELECT 
                    p.date, p.type as doc_type, p.reference, p.provider_name as entity_name, 
                    p.beneficiary_id as entity_rif, p.provider_code as account_code, 
                    acc.name as category_name, -- NOMBRE DE LA CUENTA
                    (p.total_usd - p.tax_amount_usd) as monto, p.tax_amount_usd as iva, p.total_usd as total 
                FROM purchases p
                LEFT JOIN accounts acc ON p.provider_code = acc.code
                WHERE p.company_id = $1 ${typeF}
                ${dateFilter.replace(/registration_date/g, 'p.registration_date')}
                ORDER BY account_code ASC`;
        }

        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: "Error en el servidor" }); }
});


app.listen(4000, () => {
    console.log('🚀 Backend Contable (FULL) corriendo en http://localhost:4000');
});