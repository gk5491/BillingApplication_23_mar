// @ts-nocheck
import { Router } from "express";
import bcrypt from "bcryptjs";
import { db } from "./db.js";
import { authenticate, signToken, AuthRequest } from "./auth.js";
import { v4 as uuidv4 } from "uuid";


const router = Router();
const FIXED_PAGE_LIMIT = 10;

function requireAdmin(req: AuthRequest, res: any): boolean {
  if (req.user?.role !== "admin") {
    res.status(403).json({ error: "Admin access required" });
    return false;
  }
  return true;
}

function getPaginationParams(req: any) {
  const shouldPaginate = req.query.page !== undefined || req.query.limit !== undefined;
  const parsedPage = Number.parseInt(String(req.query.page ?? "1"), 10);
  const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const limit = FIXED_PAGE_LIMIT;
  const offset = (page - 1) * limit;
  return { shouldPaginate, page, limit, offset };
}

async function runRawQuery(sqlText: string, inputs: Record<string, any> = {}) {
  const request = await db.request();
  Object.entries(inputs).forEach(([key, value]) => {
    request.input(key, value);
  });
  return request.query(sqlText);
}

async function sendPaginatedResults(req: any, res: any, dataQuery: string, countQuery: string) {
  const { shouldPaginate, page, limit, offset } = getPaginationParams(req);

  if (!shouldPaginate) {
    const result = await runRawQuery(dataQuery);
    res.json(result.recordset);
    return;
  }

  const [dataResult, countResult] = await Promise.all([
    runRawQuery(`${dataQuery} OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`, { offset, limit }),
    runRawQuery(countQuery),
  ]);

  const total = Number(countResult.recordset[0]?.total || 0);
  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
  const start = total === 0 ? 0 : offset + 1;
  const end = total === 0 ? 0 : Math.min(offset + dataResult.recordset.length, total);

  res.json({
    data: dataResult.recordset,
    pagination: {
      page,
      limit,
      total,
      totalPages,
      start,
      end,
    },
  });
}

function sendPaginatedArray(req: any, res: any, items: any[]) {
  const { shouldPaginate, page, limit, offset } = getPaginationParams(req);

  if (!shouldPaginate) {
    res.json(items);
    return;
  }

  const total = items.length;
  const data = items.slice(offset, offset + limit);
  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
  const start = total === 0 ? 0 : offset + 1;
  const end = total === 0 ? 0 : Math.min(offset + data.length, total);

  res.json({
    data,
    pagination: {
      page,
      limit,
      total,
      totalPages,
      start,
      end,
    },
  });
}

// ===== HELPER: Generate Document Number =====
async function generateDocNumber(docType: string): Promise<string> {
  const defaults: Record<string, { prefix: string; padding: number }> = {
    sales_return: { prefix: "SR-", padding: 4 },
    purchase_return: { prefix: "PRTN-", padding: 4 },
    journal_entry: { prefix: "JE-", padding: 4 },
    pos_order: { prefix: "POS-", padding: 4 },
  };

  let seqResult = await db.query`SELECT * FROM document_sequences WHERE document_type = ${docType}`;
  let seq = seqResult.recordset[0];

  if (!seq) {
    const fallback = defaults[docType];
    if (!fallback) throw new Error(`Document sequence not found: ${docType}`);

    const id = uuidv4();
    await db.query`INSERT INTO document_sequences (id, document_type, prefix, next_number, padding)
      VALUES (${id}, ${docType}, ${fallback.prefix}, 1, ${fallback.padding})`;

    seqResult = await db.query`SELECT * FROM document_sequences WHERE document_type = ${docType}`;
    seq = seqResult.recordset[0];
  }

  const num = seq.next_number;
  const padded = String(num).padStart(seq.padding, "0");
  await db.query`UPDATE document_sequences SET next_number = ${num + 1} WHERE id = ${seq.id}`;
  return seq.prefix + padded;
}

// ===== HELPER: Update stock =====
// ===== HELPER: Update stock =====
async function updateStock(itemId: string, qty: number, movementType: any, refId: string, refType: string, cost: number = 0, userId?: string) {
  const itemResult = await db.query`SELECT * FROM items WHERE id = ${itemId}`;
  const item = itemResult.recordset[0];
  if (!item) return;
  const isInflow = ["purchase", "vendor_credit", "in"].includes(movementType);
  const newStock = Number(item.current_stock) + (isInflow ? qty : -qty);
  const effectiveCost = Number(cost || item.purchase_rate || 0);
  await db.query`UPDATE items SET current_stock = ${newStock} WHERE id = ${itemId}`;
  const movementId = uuidv4();
  await db.query`INSERT INTO stock_movements (id, item_id, movement_type, quantity, cost_price, reference_id, reference_type, created_by, created_at) 
    VALUES (${movementId}, ${itemId}, ${movementType}, ${qty}, ${effectiveCost}, ${refId}, ${refType}, ${userId || null}, GETDATE())`;
}

function normalizeAccountText(value: string) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

async function computeDerivedAccountBalances(accounts: any[]) {
  const [
    invoices,
    bills,
    paymentsReceived,
    paymentsMade,
    expenses,
    creditNotes,
    vendorCredits,
    salesReturns,
    purchaseReturns,
    items,
  ] = await Promise.all([
    db.query`SELECT total, balance_due, tax_amount FROM invoices`.then((res) => res.recordset),
    db.query`SELECT total, balance_due, tax_amount FROM bills`.then((res) => res.recordset),
    db.query`SELECT amount FROM payments_received`.then((res) => res.recordset),
    db.query`SELECT amount FROM payments_made`.then((res) => res.recordset),
    db.query`SELECT category, amount, tax_amount, payment_mode FROM expenses`.then((res) => res.recordset),
    db.query`SELECT total FROM credit_notes`.then((res) => res.recordset),
    db.query`SELECT total FROM vendor_credits`.then((res) => res.recordset),
    db.query`SELECT total FROM sales_returns`.then((res) => res.recordset),
    db.query`SELECT total FROM purchase_returns`.then((res) => res.recordset),
    db.query`SELECT current_stock, purchase_rate FROM items`.then((res) => res.recordset),
  ]);

  const sumField = (rows: any[], field: string) => rows.reduce((sum: number, row: any) => sum + Number(row?.[field] || 0), 0);
  const expenseTotalsByCategory = new Map<string, number>();
  for (const expense of expenses) {
    const category = normalizeAccountText(expense.category || "general expense");
    const total = Number(expense.amount || 0) + Number(expense.tax_amount || 0);
    expenseTotalsByCategory.set(category, (expenseTotalsByCategory.get(category) || 0) + total);
  }

  const receivables = sumField(invoices, "balance_due");
  const payables = sumField(bills, "balance_due");
  const netSales = sumField(invoices, "total") - sumField(creditNotes, "total") - sumField(salesReturns, "total");
  const purchaseSpend = sumField(bills, "total") - sumField(vendorCredits, "total") - sumField(purchaseReturns, "total");
  const directExpenses = expenses.reduce((sum: number, row: any) => sum + Number(row.amount || 0) + Number(row.tax_amount || 0), 0);
  const cashPosition = sumField(paymentsReceived, "amount") - sumField(paymentsMade, "amount") - directExpenses;
  const inventoryValue = items.reduce((sum: number, row: any) => sum + (Number(row.current_stock || 0) * Number(row.purchase_rate || 0)), 0);
  const equityValue = netSales - purchaseSpend - directExpenses;

  const typeTotals: Record<string, number> = {
    asset: receivables + inventoryValue + cashPosition,
    liability: payables,
    income: netSales,
    expense: purchaseSpend + directExpenses,
    equity: equityValue,
  };

  const derivedById = new Map<string, number | null>();

  for (const account of accounts) {
    const type = String(account.account_type || "").toLowerCase();
    const name = normalizeAccountText(`${account.code || ""} ${account.name || ""}`);
    let derived: number | null = null;

    if (type === "asset") {
      if (/(receivable|debtor|customer)/.test(name)) derived = receivables;
      else if (/(inventory|stock)/.test(name)) derived = inventoryValue;
      else if (/(cash|bank|upi|wallet|card)/.test(name)) derived = cashPosition;
    } else if (type === "liability") {
      if (/(payable|creditor|vendor|supplier)/.test(name)) derived = payables;
    } else if (type === "income") {
      if (/(sale|revenue|income)/.test(name)) derived = netSales;
    } else if (type === "expense") {
      const matchedCategory = Array.from(expenseTotalsByCategory.entries()).find(([category]) => category && (name.includes(category) || category.includes(name)));
      if (matchedCategory) derived = matchedCategory[1];
      else if (/(purchase|cost of goods|cogs)/.test(name)) derived = purchaseSpend;
      else if (/(expense|overhead|admin|rent|salary|travel|utility|office|marketing|fuel|repair|misc)/.test(name)) derived = directExpenses;
    } else if (type === "equity") {
      if (/(equity|capital|retained|earning|owner)/.test(name)) derived = equityValue;
    }

    derivedById.set(account.id, derived);
  }

  for (const [type, total] of Object.entries(typeTotals)) {
    const accountsOfType = accounts.filter((account: any) => String(account.account_type || "").toLowerCase() === type);
    if (accountsOfType.length === 0) continue;

    const allocated = accountsOfType.reduce((sum: number, account: any) => sum + Number(derivedById.get(account.id) || 0), 0);
    const residual = total - allocated;
    if (Math.abs(residual) <= 0.001) continue;

    const target = accountsOfType.find((account: any) => derivedById.get(account.id) == null) || accountsOfType[0];
    derivedById.set(target.id, Number(derivedById.get(target.id) || 0) + residual);
  }

  return accounts.map((account: any) => {
    const storedBalance = Number(account.balance || 0);
    const derivedBalance = Number(derivedById.get(account.id) || 0);
    return {
      ...account,
      stored_balance: storedBalance,
      derived_balance: derivedBalance,
      balance: storedBalance + derivedBalance,
    };
  });
}

// ===== AUTH ROUTES =====
router.post("/auth/signup", async (req, res) => {
  try {
    const { email, password, username, display_name } = req.body;
    const ip_address = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || null;
    const user_agent = (req.headers["user-agent"] as string) || null;

    // Check if user exists
    const existing = await db.query`SELECT * FROM users WHERE email = ${email} OR username = ${username || email}`;
    if (existing.recordset.length > 0) {
      res.status(400).json({ error: "User already exists" });
      return;
    }

    const password_hash = await bcrypt.hash(password, 10);
    const user_id = uuidv4();

    // Insert into users
    await db.query`INSERT INTO users (id, username, email, password_hash, is_active, created_at, updated_at) 
      VALUES (${user_id}, ${username || email}, ${email}, ${password_hash}, 1, GETDATE(), GETDATE())`;

    // Insert into profiles
    const profile_id = uuidv4();
    await db.query`INSERT INTO profiles (id, user_id, display_name, email, created_at, updated_at) 
      VALUES (${profile_id}, ${user_id}, ${display_name || username || email}, ${email}, GETDATE(), GETDATE())`;

    // Default role = admin for first user, viewer for others
    const anyRoleResult = await db.query`SELECT TOP 1 * FROM user_roles`;
    const role = anyRoleResult.recordset.length === 0 ? "admin" : "viewer";
    const role_id = uuidv4();
    await db.query`INSERT INTO user_roles (id, user_id, role, created_at) VALUES (${role_id}, ${user_id}, ${role}, GETDATE())`;

    const token = signToken({ id: user_id, email, role });

    // Auth Session
    const session_id = uuidv4();
    const expires_at = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await db.query`INSERT INTO auth_sessions (id, user_id, jwt_token, issued_at, expires_at, ip_address, user_agent, created_at) 
      VALUES (${session_id}, ${user_id}, ${token}, GETDATE(), ${expires_at}, ${ip_address}, ${user_agent}, GETDATE())`;

    // Audit Log
    const log_id = uuidv4();
    await db.query`INSERT INTO auth_audit_logs (id, user_id, email, event_type, success, message, ip_address, user_agent, created_at) 
      VALUES (${log_id}, ${user_id}, ${email}, 'signup', 1, 'User created successfully', ${ip_address}, ${user_agent}, GETDATE())`;

    res.status(201).json({
      token,
      user: {
        id: user_id,
        username: username || email,
        email,
        display_name: display_name || username || email,
        role
      }
    });
  } catch (e: any) {
    console.error("Signup error:", e);
    res.status(500).json({ error: e.message });
  }
});

router.post("/auth/signin", async (req, res) => {
  try {
    const { email, password } = req.body;
    const ip_address = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || null;
    const user_agent = (req.headers["user-agent"] as string) || null;

    const userResult = await db.query`
      SELECT u.*, p.display_name 
      FROM users u 
      LEFT JOIN profiles p ON u.id = p.user_id 
      WHERE u.email = ${email} OR u.username = ${email}`;
    const user = userResult.recordset[0];

    if (!user || !user.is_active || !(await bcrypt.compare(password, user.password_hash))) {
      const log_id = uuidv4();
      await db.query`INSERT INTO auth_audit_logs (id, email, event_type, success, message, ip_address, user_agent, created_at) 
        VALUES (${log_id}, ${email}, 'signin', 0, 'Invalid email or password', ${ip_address}, ${user_agent}, GETDATE())`;
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    const roleResult = await db.query`SELECT * FROM user_roles WHERE user_id = ${user.id}`;
    const roleRow = roleResult.recordset[0];
    const token = signToken({ id: user.id, email: user.email, role: roleRow?.role });

    const session_id = uuidv4();
    const expires_at = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await db.query`INSERT INTO auth_sessions (id, user_id, jwt_token, issued_at, expires_at, ip_address, user_agent, created_at) 
      VALUES (${session_id}, ${user.id}, ${token}, GETDATE(), ${expires_at}, ${ip_address}, ${user_agent}, GETDATE())`;

    const log_id = uuidv4();
    await db.query`INSERT INTO auth_audit_logs (id, user_id, email, event_type, success, message, ip_address, user_agent, created_at) 
      VALUES (${log_id}, ${user.id}, ${user.email}, 'signin', 1, 'Signin successful', ${ip_address}, ${user_agent}, GETDATE())`;

    res.json({ token, user: { id: user.id, email: user.email, username: user.username, display_name: user.display_name, role: roleRow?.role } });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/auth/me", authenticate, async (req: AuthRequest, res) => {
  try {
    const userResult = await db.query`
      SELECT u.*, p.display_name 
      FROM users u 
      LEFT JOIN profiles p ON u.id = p.user_id 
      WHERE u.id = ${req.user!.id}`;
    const user = userResult.recordset[0];
    if (!user) { res.status(404).json({ error: "User not found" }); return; }

    const roleResult = await db.query`SELECT * FROM user_roles WHERE user_id = ${user.id}`;
    const roleRow = roleResult.recordset[0];
    res.json({ id: user.id, email: user.email, username: user.username, display_name: user.display_name, role: roleRow?.role });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ===== CUSTOMERS =====
router.get("/customers", authenticate, async (req, res) => {
  try {
    await sendPaginatedResults(req, res, `
      SELECT
        c.id,
        c.name,
        c.email,
        c.phone,
        c.gstin,
        c.pan,
        c.billing_address,
        c.shipping_address,
        c.state,
        c.credit_limit,
        c.is_active,
        c.created_by,
        c.created_at,
        c.updated_at,
        COALESCE((SELECT SUM(COALESCE(i.balance_due, 0)) FROM invoices i WHERE i.customer_id = c.id), 0) as outstanding_balance,
        COALESCE((SELECT SUM(COALESCE(i.total, 0)) FROM invoices i WHERE i.customer_id = c.id), 0) as total_sales,
        COALESCE((SELECT COUNT(*) FROM invoices i WHERE i.customer_id = c.id), 0) as invoice_count
      FROM customers c
      ORDER BY c.created_at DESC
    `, `SELECT COUNT(*) as total FROM customers`);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/customers/:id", authenticate, async (req, res) => {
  try {
    const customerId = req.params.id;
    const customerResult = await db.query`
      SELECT
        c.id,
        c.name,
        c.email,
        c.phone,
        c.gstin,
        c.pan,
        c.billing_address,
        c.shipping_address,
        c.state,
        c.credit_limit,
        c.is_active,
        c.created_by,
        c.created_at,
        c.updated_at,
        COALESCE((SELECT SUM(COALESCE(i.balance_due, 0)) FROM invoices i WHERE i.customer_id = c.id), 0) as outstanding_balance,
        COALESCE((SELECT SUM(COALESCE(i.total, 0)) FROM invoices i WHERE i.customer_id = c.id), 0) as total_sales,
        COALESCE((SELECT SUM(COALESCE(pr.amount, 0)) FROM payments_received pr WHERE pr.customer_id = c.id), 0) as total_received,
        COALESCE((SELECT SUM(COALESCE(cn.total, 0)) FROM credit_notes cn WHERE cn.customer_id = c.id), 0) as total_credits,
        COALESCE((SELECT SUM(COALESCE(sr.total, 0)) FROM sales_returns sr WHERE sr.customer_id = c.id), 0) as total_returns,
        COALESCE((SELECT COUNT(*) FROM quotations q WHERE q.customer_id = c.id), 0) as quotation_count,
        COALESCE((SELECT COUNT(*) FROM sales_orders so WHERE so.customer_id = c.id), 0) as sales_order_count,
        COALESCE((SELECT COUNT(*) FROM delivery_challans dc WHERE dc.customer_id = c.id), 0) as delivery_challan_count,
        COALESCE((SELECT COUNT(*) FROM invoices i WHERE i.customer_id = c.id), 0) as invoice_count
      FROM customers c
      WHERE c.id = ${customerId}
    `;
    const customer = customerResult.recordset[0];
    if (!customer) { res.status(404).json({ error: "Not found" }); return; }

    const [quotationsResult, salesOrdersResult, deliveryChallansResult, invoicesResult, paymentsResult, creditNotesResult, salesReturnsResult, itemSalesResult] = await Promise.all([
      db.query`SELECT id, document_number, date, total, status FROM quotations WHERE customer_id = ${customerId} ORDER BY date DESC, created_at DESC`,
      db.query`SELECT id, document_number, date, total, status FROM sales_orders WHERE customer_id = ${customerId} ORDER BY date DESC, created_at DESC`,
      db.query`SELECT id, document_number, date, total, status FROM delivery_challans WHERE customer_id = ${customerId} ORDER BY date DESC, created_at DESC`,
      db.query`SELECT id, document_number, date, due_date, total, balance_due, status FROM invoices WHERE customer_id = ${customerId} ORDER BY date DESC, created_at DESC`,
      db.query`
        SELECT pr.id, pr.payment_number, pr.date, pr.amount, pr.payment_mode, pr.reference_number, pr.invoice_id, i.document_number as invoice_number
        FROM payments_received pr
        LEFT JOIN invoices i ON pr.invoice_id = i.id
        WHERE pr.customer_id = ${customerId}
        ORDER BY pr.date DESC, pr.created_at DESC
      `,
      db.query`SELECT id, document_number, date, total, status FROM credit_notes WHERE customer_id = ${customerId} ORDER BY date DESC, created_at DESC`,
      db.query`SELECT id, document_number, date, total, status FROM sales_returns WHERE customer_id = ${customerId} ORDER BY date DESC, created_at DESC`,
      db.query`
        SELECT TOP 10
          ii.item_id,
          COALESCE(it.name, ii.description, 'Item') as item_name,
          COALESCE(it.hsn_code, '') as hsn_code,
          SUM(COALESCE(ii.quantity, 0)) as total_quantity,
          SUM(COALESCE(ii.amount, 0) + COALESCE(ii.tax_amount, 0)) as total_value
        FROM invoice_items ii
        INNER JOIN invoices inv ON ii.invoice_id = inv.id
        LEFT JOIN items it ON ii.item_id = it.id
        WHERE inv.customer_id = ${customerId}
        GROUP BY ii.item_id, it.name, ii.description, it.hsn_code
        ORDER BY total_value DESC
      `
    ]);

    res.json({
      ...customer,
      history: {
        quotations: quotationsResult.recordset,
        salesOrders: salesOrdersResult.recordset,
        deliveryChallans: deliveryChallansResult.recordset,
        invoices: invoicesResult.recordset,
        payments: paymentsResult.recordset,
        creditNotes: creditNotesResult.recordset,
        salesReturns: salesReturnsResult.recordset,
      },
      itemSales: itemSalesResult.recordset,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/customers", authenticate, async (req: AuthRequest, res) => {
  try {
    const id = uuidv4();
    const { name, email, phone, gstin, pan, billing_address, shipping_address, state, credit_limit, outstanding_balance, is_active } = req.body;
    await db.query`INSERT INTO customers (id, name, email, phone, gstin, pan, billing_address, shipping_address, state, credit_limit, outstanding_balance, is_active, created_by, created_at, updated_at) 
      VALUES (${id}, ${name}, ${email || null}, ${phone || null}, ${gstin || null}, ${pan || null}, ${billing_address || null}, ${shipping_address || null}, ${state || null}, ${credit_limit || 0}, ${outstanding_balance || 0}, ${is_active ?? true}, ${req.user!.id}, GETDATE(), GETDATE())`;
    const dataResult = await db.query`SELECT * FROM customers WHERE id = ${id}`;
    res.json(dataResult.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/customers/:id", authenticate, async (req, res) => {
  try {
    const { name, email, phone, gstin, pan, billing_address, shipping_address, state, credit_limit, outstanding_balance, is_active } = req.body;
    await db.query`UPDATE customers SET name = COALESCE(${name}, name), email = COALESCE(${email}, email), phone = COALESCE(${phone}, phone), gstin = COALESCE(${gstin}, gstin), pan = COALESCE(${pan}, pan), billing_address = COALESCE(${billing_address}, billing_address), shipping_address = COALESCE(${shipping_address}, shipping_address), state = COALESCE(${state}, state), credit_limit = COALESCE(${credit_limit}, credit_limit), outstanding_balance = COALESCE(${outstanding_balance}, outstanding_balance), is_active = COALESCE(${is_active}, is_active), updated_at = GETDATE() WHERE id = ${req.params.id}`;
    const dataResult = await db.query`SELECT * FROM customers WHERE id = ${req.params.id}`;
    res.json(dataResult.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/customers/:id", authenticate, async (req, res) => {
  try {
    await db.query`DELETE FROM customers WHERE id = ${req.params.id}`;
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/customers/:id/ledger", authenticate, async (req, res) => {
  try {
    const cid = req.params.id;
    const [invRowsResult, pmtRowsResult, cnRowsResult] = await Promise.all([
      db.query`SELECT id, document_number, date, total, balance_due, status FROM invoices WHERE customer_id = ${cid} ORDER BY date DESC`,
      db.query`SELECT id, payment_number, date, amount, payment_mode FROM payments_received WHERE customer_id = ${cid} ORDER BY date DESC`,
      db.query`SELECT id, document_number, date, total, status FROM credit_notes WHERE customer_id = ${cid} ORDER BY date DESC`,
    ]);
    res.json({ invoices: invRowsResult.recordset, payments: pmtRowsResult.recordset, creditNotes: cnRowsResult.recordset });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ===== VENDORS =====
router.get("/vendors", authenticate, async (req, res) => {
  try {
    await sendPaginatedResults(req, res, `
      SELECT
        v.id,
        v.name,
        v.email,
        v.phone,
        v.gstin,
        v.pan,
        v.address,
        v.state,
        v.is_active,
        v.created_by,
        v.created_at,
        v.updated_at,
        COALESCE((SELECT SUM(COALESCE(b.balance_due, 0)) FROM bills b WHERE b.vendor_id = v.id), 0) as outstanding_balance,
        COALESCE((SELECT SUM(COALESCE(b.total, 0)) FROM bills b WHERE b.vendor_id = v.id), 0) as total_purchases,
        COALESCE((SELECT COUNT(*) FROM bills b WHERE b.vendor_id = v.id), 0) as bill_count
      FROM vendors v
      ORDER BY v.created_at DESC
    `, `SELECT COUNT(*) as total FROM vendors`);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/vendors/:id", authenticate, async (req, res) => {
  try {
    const vendorId = req.params.id;
    const vendorResult = await db.query`
      SELECT
        v.id,
        v.name,
        v.email,
        v.phone,
        v.gstin,
        v.pan,
        v.address,
        v.state,
        v.is_active,
        v.created_by,
        v.created_at,
        v.updated_at,
        COALESCE((SELECT SUM(COALESCE(b.balance_due, 0)) FROM bills b WHERE b.vendor_id = v.id), 0) as outstanding_balance,
        COALESCE((SELECT SUM(COALESCE(b.total, 0)) FROM bills b WHERE b.vendor_id = v.id), 0) as total_purchases,
        COALESCE((SELECT SUM(COALESCE(pm.amount, 0)) FROM payments_made pm WHERE pm.vendor_id = v.id), 0) as total_paid,
        COALESCE((SELECT SUM(COALESCE(vc.total, 0)) FROM vendor_credits vc WHERE vc.vendor_id = v.id), 0) as total_credits,
        COALESCE((SELECT SUM(COALESCE(pr.total, 0)) FROM purchase_returns pr WHERE pr.vendor_id = v.id), 0) as total_returns,
        COALESCE((SELECT COUNT(*) FROM purchase_orders po WHERE po.vendor_id = v.id), 0) as purchase_order_count,
        COALESCE((SELECT COUNT(*) FROM bills b WHERE b.vendor_id = v.id), 0) as bill_count
      FROM vendors v
      WHERE v.id = ${vendorId}
    `;
    const vendor = vendorResult.recordset[0];
    if (!vendor) { res.status(404).json({ error: "Not found" }); return; }

    const [purchaseOrdersResult, billsResult, paymentsResult, vendorCreditsResult, purchaseReturnsResult, itemPurchasesResult] = await Promise.all([
      db.query`SELECT id, document_number, date, total, status FROM purchase_orders WHERE vendor_id = ${vendorId} ORDER BY date DESC, created_at DESC`,
      db.query`SELECT id, document_number, date, due_date, total, balance_due, status FROM bills WHERE vendor_id = ${vendorId} ORDER BY date DESC, created_at DESC`,
      db.query`
        SELECT pm.id, pm.payment_number, pm.date, pm.amount, pm.payment_mode, pm.reference_number, pm.bill_id, b.document_number as bill_number
        FROM payments_made pm
        LEFT JOIN bills b ON pm.bill_id = b.id
        WHERE pm.vendor_id = ${vendorId}
        ORDER BY pm.date DESC, pm.created_at DESC
      `,
      db.query`SELECT id, document_number, date, total, status FROM vendor_credits WHERE vendor_id = ${vendorId} ORDER BY date DESC, created_at DESC`,
      db.query`SELECT id, document_number, date, total, status FROM purchase_returns WHERE vendor_id = ${vendorId} ORDER BY date DESC, created_at DESC`,
      db.query`
        SELECT TOP 10
          bi.item_id,
          COALESCE(it.name, bi.description, 'Item') as item_name,
          COALESCE(it.hsn_code, '') as hsn_code,
          SUM(COALESCE(bi.quantity, 0)) as total_quantity,
          SUM(COALESCE(bi.amount, 0) + COALESCE(bi.tax_amount, 0)) as total_value
        FROM bill_items bi
        INNER JOIN bills b ON bi.bill_id = b.id
        LEFT JOIN items it ON bi.item_id = it.id
        WHERE b.vendor_id = ${vendorId}
        GROUP BY bi.item_id, it.name, bi.description, it.hsn_code
        ORDER BY total_value DESC
      `
    ]);

    res.json({
      ...vendor,
      history: {
        purchaseOrders: purchaseOrdersResult.recordset,
        bills: billsResult.recordset,
        payments: paymentsResult.recordset,
        vendorCredits: vendorCreditsResult.recordset,
        purchaseReturns: purchaseReturnsResult.recordset,
      },
      itemPurchases: itemPurchasesResult.recordset,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/vendors", authenticate, async (req: AuthRequest, res) => {
  try {
    const id = uuidv4();
    const { name, email, phone, gstin, pan, address, state, outstanding_balance, is_active } = req.body;
    await db.query`INSERT INTO vendors (id, name, email, phone, gstin, pan, address, state, outstanding_balance, is_active, created_by, created_at, updated_at) 
      VALUES (${id}, ${name}, ${email || null}, ${phone || null}, ${gstin || null}, ${pan || null}, ${address || null}, ${state || null}, ${outstanding_balance || 0}, ${is_active ?? true}, ${req.user!.id}, GETDATE(), GETDATE())`;
    const dataResult = await db.query`SELECT * FROM vendors WHERE id = ${id}`;
    res.json(dataResult.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/vendors/:id", authenticate, async (req, res) => {
  try {
    const { name, email, phone, gstin, pan, address, state, outstanding_balance, is_active } = req.body;
    await db.query`UPDATE vendors SET name = COALESCE(${name}, name), email = COALESCE(${email}, email), phone = COALESCE(${phone}, phone), gstin = COALESCE(${gstin}, gstin), pan = COALESCE(${pan}, pan), address = COALESCE(${address}, address), state = COALESCE(${state}, state), outstanding_balance = COALESCE(${outstanding_balance}, outstanding_balance), is_active = COALESCE(${is_active}, is_active), updated_at = GETDATE() WHERE id = ${req.params.id}`;
    const dataResult = await db.query`SELECT * FROM vendors WHERE id = ${req.params.id}`;
    res.json(dataResult.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/vendors/:id", authenticate, async (req, res) => {
  try {
    await db.query`DELETE FROM vendors WHERE id = ${req.params.id}`;
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/vendors/:id/ledger", authenticate, async (req, res) => {
  try {
    const vid = req.params.id;
    const [billRowsResult, pmtRowsResult] = await Promise.all([
      db.query`SELECT id, document_number, date, total, balance_due, status FROM bills WHERE vendor_id = ${vid} ORDER BY date DESC`,
      db.query`SELECT id, payment_number, date, amount, payment_mode FROM payments_made WHERE vendor_id = ${vid} ORDER BY date DESC`,
    ]);
    res.json({ bills: billRowsResult.recordset, payments: pmtRowsResult.recordset });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ===== ITEMS =====
router.get("/items", authenticate, async (req, res) => {
  try {
    await sendPaginatedResults(req, res, `
      SELECT i.*, tr.name as tax_rate_name, tr.rate as tax_rate_value
      FROM items i
      LEFT JOIN tax_rates tr ON i.tax_rate_id = tr.id
      ORDER BY i.created_at DESC
    `, `SELECT COUNT(*) as total FROM items`);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/items/:id", authenticate, async (req, res) => {
  try {
    const itemId = req.params.id;
    const dataResult = await db.query`
      SELECT
        i.id,
        i.name,
        i.sku,
        i.hsn_code,
        i.category,
        i.unit,
        i.purchase_rate,
        i.selling_rate,
        i.tax_rate_id,
        i.opening_stock,
        i.current_stock,
        i.reorder_level,
        i.is_active,
        i.created_by,
        i.created_at,
        i.updated_at,
        tr.name as tax_rate_name,
        tr.rate as tax_rate_value,
        COALESCE((SELECT SUM(COALESCE(ii.quantity, 0)) FROM invoice_items ii WHERE ii.item_id = i.id), 0) as sold_quantity,
        COALESCE((SELECT SUM(COALESCE(ii.amount, 0) + COALESCE(ii.tax_amount, 0)) FROM invoice_items ii WHERE ii.item_id = i.id), 0) as sales_value,
        COALESCE((SELECT SUM(COALESCE(bi.quantity, 0)) FROM bill_items bi WHERE bi.item_id = i.id), 0) as purchased_quantity,
        COALESCE((SELECT SUM(COALESCE(bi.amount, 0) + COALESCE(bi.tax_amount, 0)) FROM bill_items bi WHERE bi.item_id = i.id), 0) as purchase_value
      FROM items i
      LEFT JOIN tax_rates tr ON i.tax_rate_id = tr.id
      WHERE i.id = ${itemId}
    `;
    const data = dataResult.recordset[0];
    if (!data) { res.status(404).json({ error: "Not found" }); return; }

    const [stockResult, salesHistoryResult, purchaseHistoryResult] = await Promise.all([
      db.query`SELECT * FROM stock_movements WHERE item_id = ${itemId} ORDER BY created_at DESC`,
      db.query`
        SELECT TOP 20
          inv.id as document_id,
          inv.document_number,
          inv.date,
          inv.customer_id,
          c.name as customer_name,
          ii.quantity,
          ii.rate,
          ii.tax_amount,
          ii.amount,
          (COALESCE(ii.amount, 0) + COALESCE(ii.tax_amount, 0)) as line_total
        FROM invoice_items ii
        INNER JOIN invoices inv ON ii.invoice_id = inv.id
        LEFT JOIN customers c ON inv.customer_id = c.id
        WHERE ii.item_id = ${itemId}
        ORDER BY inv.date DESC, inv.created_at DESC
      `,
      db.query`
        SELECT TOP 20
          b.id as document_id,
          b.document_number,
          b.date,
          b.vendor_id,
          v.name as vendor_name,
          bi.quantity,
          bi.rate,
          bi.tax_amount,
          bi.amount,
          (COALESCE(bi.amount, 0) + COALESCE(bi.tax_amount, 0)) as line_total
        FROM bill_items bi
        INNER JOIN bills b ON bi.bill_id = b.id
        LEFT JOIN vendors v ON b.vendor_id = v.id
        WHERE bi.item_id = ${itemId}
        ORDER BY b.date DESC, b.created_at DESC
      `
    ]);

    res.json({
      ...data,
      stock_movements: stockResult.recordset,
      sales_history: salesHistoryResult.recordset,
      purchase_history: purchaseHistoryResult.recordset,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/items", authenticate, async (req: AuthRequest, res) => {
  try {
    const id = uuidv4();
    const { name, sku, hsn_code, category, unit, purchase_rate, selling_rate, tax_rate_id, opening_stock, reorder_level, is_active } = req.body;
    const current_stock = opening_stock || 0;
    await db.query`INSERT INTO items (id, name, sku, hsn_code, category, unit, purchase_rate, selling_rate, tax_rate_id, opening_stock, current_stock, reorder_level, is_active, created_by, created_at, updated_at) 
      VALUES (${id}, ${name}, ${sku || null}, ${hsn_code || null}, ${category || null}, ${unit || null}, ${purchase_rate || 0}, ${selling_rate || 0}, ${tax_rate_id || null}, ${opening_stock || 0}, ${current_stock}, ${reorder_level || 0}, ${is_active ?? true}, ${req.user!.id}, GETDATE(), GETDATE())`;
    const dataResult = await db.query`SELECT * FROM items WHERE id = ${id}`;
    res.json(dataResult.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/items/:id", authenticate, async (req, res) => {
  try {
    const { name, sku, hsn_code, category, unit, purchase_rate, selling_rate, tax_rate_id, current_stock, reorder_level, is_active } = req.body;
    await db.query`UPDATE items SET name = COALESCE(${name}, name), sku = COALESCE(${sku}, sku), hsn_code = COALESCE(${hsn_code}, hsn_code), category = COALESCE(${category}, category), unit = COALESCE(${unit}, unit), purchase_rate = COALESCE(${purchase_rate}, purchase_rate), selling_rate = COALESCE(${selling_rate}, selling_rate), tax_rate_id = COALESCE(${tax_rate_id}, tax_rate_id), current_stock = COALESCE(${current_stock}, current_stock), reorder_level = COALESCE(${reorder_level}, reorder_level), is_active = COALESCE(${is_active}, is_active), updated_at = GETDATE() WHERE id = ${req.params.id}`;
    const dataResult = await db.query`SELECT * FROM items WHERE id = ${req.params.id}`;
    res.json(dataResult.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/items/:id", authenticate, async (req, res) => {
  try {
    await db.query`DELETE FROM items WHERE id = ${req.params.id}`;
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/items/:id/stock", authenticate, async (req, res) => {
  try {
    const dataResult = await db.query`SELECT * FROM stock_movements WHERE item_id = ${req.params.id} ORDER BY created_at DESC`;
    res.json(dataResult.recordset);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ===== JOURNAL ENTRIES =====
router.get("/journal-entries", authenticate, async (req, res) => {
  try {
    const { shouldPaginate, page, limit, offset } = getPaginationParams(req);
    const entriesResult = shouldPaginate
      ? await runRawQuery(`
      SELECT je.*
      FROM journal_entries je
      ORDER BY je.date DESC, je.created_at DESC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `, { offset, limit })
      : await db.query`
      SELECT je.*
      FROM journal_entries je
      ORDER BY je.date DESC, je.created_at DESC
    `;
    const entries = entriesResult.recordset;

    for (const entry of entries) {
      const lines = await db.query`
        SELECT jel.*, a.name as account_name, a.code as account_code, a.account_type
        FROM journal_entry_lines jel
        LEFT JOIN accounts a ON jel.account_id = a.id
        WHERE jel.journal_entry_id = ${entry.id}
      `.then(res => res.recordset);
      entry.journal_entry_lines = lines;
    }

    if (!shouldPaginate) {
      res.json(entries);
      return;
    }

    const countResult = await runRawQuery(`SELECT COUNT(*) as total FROM journal_entries`);
    const total = Number(countResult.recordset[0]?.total || 0);
    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
    const start = total === 0 ? 0 : offset + 1;
    const end = total === 0 ? 0 : Math.min(offset + entries.length, total);

    res.json({
      data: entries,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        start,
        end,
      },
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/journal-entries/:id", authenticate, async (req, res) => {
  try {
    const entryResult = await db.query`SELECT * FROM journal_entries WHERE id = ${req.params.id}`;
    const entry = entryResult.recordset[0];
    if (!entry) { res.status(404).json({ error: "Not found" }); return; }

    const lines = await db.query`
      SELECT jel.*, a.name as account_name, a.code as account_code, a.account_type
      FROM journal_entry_lines jel
      LEFT JOIN accounts a ON jel.account_id = a.id
      WHERE jel.journal_entry_id = ${req.params.id}
    `.then(res => res.recordset);

    res.json({ ...entry, journal_entry_lines: lines });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/journal-entries", authenticate, async (req: AuthRequest, res) => {
  try {
    const id = uuidv4();
    const { date, description, journal_type, reference_id, reference_type, is_auto, lines } = req.body;
    const document_number = await generateDocNumber('journal_entry');
    const totalDebit = (lines || []).reduce((sum, line) => sum + Number(line.debit || 0), 0);
    const totalCredit = (lines || []).reduce((sum, line) => sum + Number(line.credit || 0), 0);

    if (!Array.isArray(lines) || lines.length < 2) {
      res.status(400).json({ error: 'Journal entry requires at least two lines' });
      return;
    }

    if (Math.abs(totalDebit - totalCredit) > 0.001) {
      res.status(400).json({ error: 'Total debit must equal total credit' });
      return;
    }

    await db.query`
      INSERT INTO journal_entries (id, document_number, date, description, journal_type, reference_id, reference_type, is_auto, created_by, created_at)
      VALUES (${id}, ${document_number}, ${date}, ${description || null}, ${journal_type || 'general'}, ${reference_id || null}, ${reference_type || null}, ${is_auto ?? false}, ${req.user!.id}, GETDATE())
    `;

    for (const line of lines) {
      await db.query`
        INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description)
        VALUES (${uuidv4()}, ${id}, ${line.account_id}, ${Number(line.debit || 0)}, ${Number(line.credit || 0)}, ${line.description || null})
      `;
    }

    const entryResult = await db.query`SELECT * FROM journal_entries WHERE id = ${id}`;
    const created = entryResult.recordset[0];
    const lineRows = await db.query`
      SELECT jel.*, a.name as account_name, a.code as account_code, a.account_type
      FROM journal_entry_lines jel
      LEFT JOIN accounts a ON jel.account_id = a.id
      WHERE jel.journal_entry_id = ${id}
    `.then(res => res.recordset);

    res.json({ ...created, journal_entry_lines: lineRows });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/journal-entries/:id", authenticate, async (req, res) => {
  try {
    await db.query`DELETE FROM journal_entry_lines WHERE journal_entry_id = ${req.params.id}`;
    await db.query`DELETE FROM journal_entries WHERE id = ${req.params.id}`;
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});
// ===== TAX RATES =====
router.get("/tax-rates", authenticate, async (req, res) => {
  try {
    const data = await db.query`SELECT * FROM tax_rates ORDER BY rate ASC`.then(res => res.recordset);
    res.json(data);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/tax-rates", authenticate, async (req, res) => {
  try {
    const id = uuidv4();
    const { name, rate, tax_type, cgst, sgst, igst, is_active, is_default } = req.body;
    await db.query`
      INSERT INTO tax_rates (id, name, rate, tax_type, cgst, sgst, igst, is_default, is_active, created_at, updated_at)
      VALUES (
        ${id},
        ${name},
        ${rate},
        ${tax_type || 'GST'},
        ${cgst ?? (Number(rate || 0) / 2)},
        ${sgst ?? (Number(rate || 0) / 2)},
        ${igst ?? Number(rate || 0)},
        ${is_default ? 1 : 0},
        ${is_active ?? true ? 1 : 0},
        GETDATE(),
        GETDATE()
      )
    `;
    const dataResult = await db.query`SELECT * FROM tax_rates WHERE id = ${id}`;
    res.json(dataResult.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/tax-rates/:id", authenticate, async (req, res) => {
  try {
    const { name, rate, tax_type, cgst, sgst, igst, is_active, is_default } = req.body;
    await db.query`
      UPDATE tax_rates
      SET name = COALESCE(${name}, name),
          rate = COALESCE(${rate}, rate),
          tax_type = COALESCE(${tax_type}, tax_type),
          cgst = COALESCE(${cgst}, cgst),
          sgst = COALESCE(${sgst}, sgst),
          igst = COALESCE(${igst}, igst),
          is_active = COALESCE(${is_active}, is_active),
          is_default = COALESCE(${is_default}, is_default),
          updated_at = GETDATE()
      WHERE id = ${req.params.id}
    `;
    const dataResult = await db.query`SELECT * FROM tax_rates WHERE id = ${req.params.id}`;
    res.json(dataResult.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/tax-rates/:id", authenticate, async (req, res) => {
  try {
    await db.query`DELETE FROM tax_rates WHERE id = ${req.params.id}`;
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ===== ACCOUNTS =====
router.get("/accounts", authenticate, async (req, res) => {
  try {
    const rawAccounts = await db.query`SELECT * FROM accounts ORDER BY code`.then(res => res.recordset);
    const data = await computeDerivedAccountBalances(rawAccounts);
    sendPaginatedArray(req, res, data);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/accounts/:id", authenticate, async (req, res) => {
  try {
    const rawAccounts = await db.query`SELECT * FROM accounts ORDER BY code`.then(res => res.recordset);
    const data = (await computeDerivedAccountBalances(rawAccounts)).find((account: any) => account.id === req.params.id);
    if (!data) { res.status(404).json({ error: "Not found" }); return; }
    res.json(data);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/accounts", authenticate, async (req, res) => {
  try {
    const id = uuidv4();
    const { code, name, account_type, parent_id, is_system, balance } = req.body;
    await db.query`INSERT INTO accounts (id, code, name, account_type, parent_id, is_system, balance, created_at, updated_at) VALUES (${id}, ${code}, ${name}, ${account_type}, ${parent_id || null}, ${is_system ?? false}, ${balance || 0}, GETDATE(), GETDATE())`;
    const dataResult = await db.query`SELECT * FROM accounts WHERE id = ${id}`;
    res.json(dataResult.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/accounts/:id", authenticate, async (req, res) => {
  try {
    const { code, name, account_type, parent_id, is_system, balance } = req.body;
    await db.query`UPDATE accounts SET code = COALESCE(${code}, code), name = COALESCE(${name}, name), account_type = COALESCE(${account_type}, account_type), parent_id = COALESCE(${parent_id}, parent_id), is_system = COALESCE(${is_system}, is_system), balance = COALESCE(${balance}, balance), updated_at = GETDATE() WHERE id = ${req.params.id}`;
    const dataResult = await db.query`SELECT * FROM accounts WHERE id = ${req.params.id}`;
    res.json(dataResult.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/accounts/:id", authenticate, async (req, res) => {
  try {
    await db.query`DELETE FROM accounts WHERE id = ${req.params.id}`;
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Archaic Quotations and Sales Orders deleted.



// Routes moved to consolidated section below




// ===== STOCK MOVEMENTS =====
router.get("/stock-movements", authenticate, async (req, res) => {
  try {
    await sendPaginatedResults(req, res, `
      SELECT
        sm.*,
        i.name AS item_name,
        i.sku AS item_sku,
        i.unit AS item_unit,
        CASE WHEN ISNULL(sm.cost_price, 0) = 0 THEN ISNULL(i.purchase_rate, 0) ELSE sm.cost_price END AS effective_cost
      FROM stock_movements sm
      LEFT JOIN items i ON sm.item_id = i.id
      ORDER BY sm.created_at DESC
    `, `SELECT COUNT(*) as total FROM stock_movements`);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ===== GST SETTINGS =====
router.get("/gst-settings", authenticate, async (req, res) => {
  try {
    const data = await db.query`SELECT TOP 1 * FROM gst_settings`.then(res => res.recordset[0]);
    res.json(data || null);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/gst-settings", authenticate, async (req, res) => {
  try {
    const existingResult = await db.query`SELECT TOP 1 * FROM gst_settings`;
    const existing = existingResult.recordset[0];
    const {
      gstin,
      legal_name,
      trade_name,
      state,
      state_code,
      is_composition,
      reverse_charge_applicable,
      einvoice_enabled,
      eway_bill_enabled,
    } = req.body;
    let data;
    if (existing) {
      await db.query`
        UPDATE gst_settings
        SET gstin = ${gstin || null},
            legal_name = ${legal_name || null},
            trade_name = ${trade_name || null},
            state = ${state || null},
            state_code = ${state_code || null},
            is_composition = ${is_composition ? 1 : 0},
            reverse_charge_applicable = ${reverse_charge_applicable ? 1 : 0},
            einvoice_enabled = ${einvoice_enabled ? 1 : 0},
            eway_bill_enabled = ${eway_bill_enabled ? 1 : 0},
            updated_at = GETDATE()
        WHERE id = ${existing.id}
      `;
      const updatedResult = await db.query`SELECT * FROM gst_settings WHERE id = ${existing.id}`;
      data = updatedResult.recordset[0];
    } else {
      const id = uuidv4();
      await db.query`
        INSERT INTO gst_settings (
          id,
          gstin,
          legal_name,
          trade_name,
          state,
          state_code,
          is_composition,
          reverse_charge_applicable,
          einvoice_enabled,
          eway_bill_enabled,
          updated_at
        )
        VALUES (
          ${id},
          ${gstin || null},
          ${legal_name || null},
          ${trade_name || null},
          ${state || null},
          ${state_code || null},
          ${is_composition ? 1 : 0},
          ${reverse_charge_applicable ? 1 : 0},
          ${einvoice_enabled ? 1 : 0},
          ${eway_bill_enabled ? 1 : 0},
          GETDATE()
        )
      `;
      const createdResult = await db.query`SELECT * FROM gst_settings WHERE id = ${id}`;
      data = createdResult.recordset[0];
    }
    res.json(data);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ===== DOCUMENT SEQUENCES =====
router.get("/document-sequences", authenticate, async (req, res) => {
  try {
    const data = await db.query`SELECT * FROM document_sequences ORDER BY document_type ASC`.then(res => res.recordset);
    res.json(data);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/document-sequences/:id", authenticate, async (req, res) => {
  try {
    const { prefix, next_number, padding } = req.body;
    await db.query`UPDATE document_sequences SET prefix = ${prefix}, next_number = ${next_number}, padding = ${padding} WHERE id = ${req.params.id}`;
    const dataResult = await db.query`SELECT * FROM document_sequences WHERE id = ${req.params.id}`;
    res.json(dataResult.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ===== COMPANY =====
router.get("/company", authenticate, async (req, res) => {
  try {
    const data = await db.query`SELECT TOP 1 * FROM companies`.then(res => res.recordset[0]);
    res.json(data || null);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/company", authenticate, async (req: AuthRequest, res) => {
  try {
    const existingResult = await db.query`SELECT TOP 1 * FROM companies`;
    const existing = existingResult.recordset[0];
    const { name, email, phone, website, address, city, state, zip_code, country, gstin, pan } = req.body;
    let data;
    if (existing) {
      await db.query`UPDATE companies SET name = ${name}, email = ${email || null}, phone = ${phone || null}, website = ${website || null}, address = ${address || null}, city = ${city || null}, state = ${state || null}, zip_code = ${zip_code || null}, country = ${country || null}, gstin = ${gstin || null}, pan = ${pan || null}, updated_at = GETDATE() WHERE id = ${existing.id}`;
      const updatedResult = await db.query`SELECT * FROM companies WHERE id = ${existing.id}`;
      data = updatedResult.recordset[0];
    } else {
      const id = uuidv4();
      await db.query`INSERT INTO companies (id, name, email, phone, website, address, city, state, zip_code, country, gstin, pan, created_by, created_at, updated_at) VALUES (${id}, ${name}, ${email || null}, ${phone || null}, ${website || null}, ${address || null}, ${city || null}, ${state || null}, ${zip_code || null}, ${country || null}, ${gstin || null}, ${pan || null}, ${req.user!.id}, GETDATE(), GETDATE())`;
      const createdResult = await db.query`SELECT * FROM companies WHERE id = ${id}`;
      data = createdResult.recordset[0];
    }
    res.json(data);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ===== INVOICE SETTINGS =====
router.get("/invoice-settings", authenticate, async (req, res) => {
  try {
    const dataResult = await db.query`SELECT TOP 1 * FROM invoice_settings`;
    res.json(dataResult.recordset[0] || null);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/invoice-settings", authenticate, async (req, res) => {
  try {
    const existingResult = await db.query`SELECT TOP 1 * FROM invoice_settings`;
    const existing = existingResult.recordset[0];
    const { prefix, nextNumber, template, footerText, terms } = req.body;
    let data;
    if (existing) {
      await db.query`UPDATE invoice_settings SET prefix = ${prefix || null}, next_number = ${nextNumber || null}, template = ${template || null}, footer_text = ${footerText || null}, terms = ${terms || null}, updated_at = GETDATE() WHERE id = ${existing.id}`;
      const updatedResult = await db.query`SELECT * FROM invoice_settings WHERE id = ${existing.id}`;
      data = updatedResult.recordset[0];
    } else {
      const id = uuidv4();
      await db.query`INSERT INTO invoice_settings (id, prefix, next_number, template, footer_text, terms, created_at, updated_at) VALUES (${id}, ${prefix || null}, ${nextNumber || null}, ${template || null}, footer_text = ${footerText || null}, terms = ${terms || null}, GETDATE(), GETDATE())`;
      const createdResult = await db.query`SELECT * FROM invoice_settings WHERE id = ${id}`;
      data = createdResult.recordset[0];
    }
    res.json(data);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ===== PROFILES =====
router.get("/profile", authenticate, async (req: AuthRequest, res) => {
  try {
    const data = await db.query`SELECT id, email, username, is_active FROM users WHERE id = ${req.user!.id}`.then(res => res.recordset[0]);
    const profile = await db.query`SELECT * FROM profiles WHERE user_id = ${req.user!.id}`.then(res => res.recordset[0]);
    res.json({ ...data, ...profile });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/profile", authenticate, async (req: AuthRequest, res) => {
  try {
    const { display_name, phone } = req.body;
    await db.query`UPDATE profiles SET display_name = ${display_name || null}, phone = ${phone || null}, updated_at = GETDATE() WHERE user_id = ${req.user!.id}`;
    const profile = await db.query`SELECT * FROM profiles WHERE user_id = ${req.user!.id}`.then(res => res.recordset[0]);
    res.json(profile);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ===== USER ROLES =====
router.get("/user-roles", authenticate, async (req, res) => {
  try {
    const data = await db.query`
      SELECT ur.id, ur.user_id, ur.role, u.email, u.username, u.is_active, p.display_name, p.phone
      FROM user_roles ur 
      LEFT JOIN users u ON ur.user_id = u.id
      LEFT JOIN profiles p ON u.id = p.user_id
      ORDER BY COALESCE(p.display_name, u.email)
    `.then(res => res.recordset);
    res.json(data);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/users", authenticate, async (req: AuthRequest, res) => {
  try {
    if (!requireAdmin(req, res)) return;

    const { email, password, username, display_name, phone, role, is_active } = req.body;
    if (!email || !password) {
      res.status(400).json({ error: "Email and password are required" });
      return;
    }

    const existing = await db.query`SELECT * FROM users WHERE email = ${email} OR username = ${username || email}`;
    if (existing.recordset.length > 0) {
      res.status(400).json({ error: "User already exists" });
      return;
    }

    const userId = uuidv4();
    const passwordHash = await bcrypt.hash(password, 10);
    await db.query`INSERT INTO users (id, username, email, password_hash, is_active, created_at, updated_at)
      VALUES (${userId}, ${username || email}, ${email}, ${passwordHash}, ${is_active ?? true}, GETDATE(), GETDATE())`;

    const profileId = uuidv4();
    await db.query`INSERT INTO profiles (id, user_id, display_name, email, phone, created_at, updated_at)
      VALUES (${profileId}, ${userId}, ${display_name || username || email}, ${email}, ${phone || null}, GETDATE(), GETDATE())`;

    const roleId = uuidv4();
    await db.query`INSERT INTO user_roles (id, user_id, role, created_at)
      VALUES (${roleId}, ${userId}, ${role || "viewer"}, GETDATE())`;

    const created = await db.query`
      SELECT ur.id, ur.user_id, ur.role, u.email, u.username, u.is_active, p.display_name, p.phone
      FROM user_roles ur
      LEFT JOIN users u ON ur.user_id = u.id
      LEFT JOIN profiles p ON u.id = p.user_id
      WHERE ur.id = ${roleId}
    `;
    res.status(201).json(created.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/users/:id", authenticate, async (req: AuthRequest, res) => {
  try {
    if (!requireAdmin(req, res)) return;

    const { email, username, display_name, phone, role, is_active, password } = req.body;
    const userId = req.params.id;

    const existing = await db.query`SELECT * FROM users WHERE id = ${userId}`;
    if (existing.recordset.length === 0) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    await db.query`UPDATE users SET email = COALESCE(${email}, email), username = COALESCE(${username}, username), is_active = COALESCE(${is_active}, is_active), updated_at = GETDATE() WHERE id = ${userId}`;
    await db.query`UPDATE profiles SET display_name = COALESCE(${display_name}, display_name), email = COALESCE(${email}, email), phone = COALESCE(${phone}, phone), updated_at = GETDATE() WHERE user_id = ${userId}`;
    if (role) {
      await db.query`UPDATE user_roles SET role = ${role} WHERE user_id = ${userId}`;
    }
    if (password) {
      const passwordHash = await bcrypt.hash(password, 10);
      await db.query`UPDATE users SET password_hash = ${passwordHash}, updated_at = GETDATE() WHERE id = ${userId}`;
    }

    const updated = await db.query`
      SELECT ur.id, ur.user_id, ur.role, u.email, u.username, u.is_active, p.display_name, p.phone
      FROM user_roles ur
      LEFT JOIN users u ON ur.user_id = u.id
      LEFT JOIN profiles p ON u.id = p.user_id
      WHERE u.id = ${userId}
    `;
    res.json(updated.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/users/:id", authenticate, async (req: AuthRequest, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (req.user!.id === req.params.id) {
      res.status(400).json({ error: "You cannot delete your own account" });
      return;
    }

    await db.query`UPDATE users SET is_active = 0, updated_at = GETDATE() WHERE id = ${req.params.id}`;
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/user-roles/:id", authenticate, async (req: AuthRequest, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const { role } = req.body;
    await db.query`UPDATE user_roles SET role = ${role} WHERE id = ${req.params.id}`;
    const dataResult = await db.query`SELECT * FROM user_roles WHERE id = ${req.params.id}`;
    res.json(dataResult.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ===== ACTIVITY LOGS =====
router.get("/activity-logs", authenticate, async (req, res) => {
  try {
    const dataResult = await db.query`SELECT TOP 50 * FROM activity_logs ORDER BY created_at DESC`;
    res.json(dataResult.recordset);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/activity-logs", authenticate, async (req: AuthRequest, res) => {
  try {
    const id = uuidv4();
    const { action, entityType, entityId, details } = req.body;
    await db.query`INSERT INTO activity_logs (id, user_id, action, entity_type, entity_id, details, created_at) VALUES (${id}, ${req.user!.id}, ${action}, ${entityType}, ${entityId || null}, ${details || null}, GETDATE())`;
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ===== ITEM CATEGORIES =====
router.get("/item-categories", authenticate, async (req, res) => {
  try {
    await sendPaginatedResults(req, res, `SELECT * FROM item_categories ORDER BY name`, `SELECT COUNT(*) as total FROM item_categories`);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/item-categories/:id", authenticate, async (req, res) => {
  try {
    const categoryResult = await db.query`SELECT * FROM item_categories WHERE id = ${req.params.id}`;
    const category = categoryResult.recordset[0];
    if (!category) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const items = await db.query`
      SELECT
        i.id,
        i.name,
        i.sku,
        i.hsn_code,
        i.category,
        i.unit,
        i.current_stock,
        i.purchase_rate,
        i.selling_rate,
        i.is_active,
        i.created_at
      FROM items i
      WHERE i.category = ${category.name}
      ORDER BY i.created_at DESC, i.name ASC
    `.then((result) => result.recordset);

    res.json({
      ...category,
      item_count: items.length,
      items,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/item-categories", authenticate, async (req, res) => {
  try {
    const id = uuidv4();
    const { name, description } = req.body;
    await db.query`INSERT INTO item_categories (id, name, description, created_at) VALUES (${id}, ${name}, ${description || null}, GETDATE())`;
    const dataResult = await db.query`SELECT * FROM item_categories WHERE id = ${id}`;
    res.json(dataResult.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/item-categories/:id", authenticate, async (req, res) => {
  try {
    await db.query`DELETE FROM item_categories WHERE id = ${req.params.id}`;
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ===== PRICE LISTS =====
router.get("/price-lists", authenticate, async (req, res) => {
  try {
    await sendPaginatedResults(req, res, `SELECT * FROM price_lists ORDER BY name`, `SELECT COUNT(*) as total FROM price_lists`);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/price-lists", authenticate, async (req, res) => {
  try {
    const id = uuidv4();
    const { name, description, is_active, items } = req.body;
    await db.query`INSERT INTO price_lists (id, name, description, is_active, created_at, updated_at) VALUES (${id}, ${name}, ${description || null}, ${is_active ?? true}, GETDATE(), GETDATE())`;
    if (items && Array.isArray(items)) {
      for (const item of items) {
        await db.query`INSERT INTO price_list_items (id, price_list_id, item_id, rate_or_percentage) VALUES (${uuidv4()}, ${id}, ${item.item_id}, ${item.rate_or_percentage || 0})`;
      }
    }
    const dataResult = await db.query`SELECT * FROM price_lists WHERE id = ${id}`;
    res.json(dataResult.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/price-lists/:id", authenticate, async (req, res) => {
  try {
    await db.query`DELETE FROM price_list_items WHERE price_list_id = ${req.params.id}`;
    await db.query`DELETE FROM price_lists WHERE id = ${req.params.id}`;
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ===== WAREHOUSES =====
router.get("/warehouses", authenticate, async (req, res) => {
  try {
    await sendPaginatedResults(req, res, `SELECT * FROM warehouses ORDER BY warehouse_name`, `SELECT COUNT(*) as total FROM warehouses`);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/warehouses", authenticate, async (req, res) => {
  try {
    const id = uuidv4();
    const warehouseName = req.body.warehouse_name || req.body.warehouseName || req.body.name;
    const { address, branch_id, is_active } = req.body;

    if (!warehouseName) {
      return res.status(400).json({ error: "warehouse_name is required" });
    }

    await db.query`INSERT INTO warehouses (id, warehouse_name, address, branch_id, is_active, created_at) VALUES (${id}, ${warehouseName}, ${address || null}, ${branch_id || null}, ${is_active ?? true}, GETDATE())`;
    const dataResult = await db.query`SELECT * FROM warehouses WHERE id = ${id}`;
    res.json(dataResult.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/warehouses/:id", authenticate, async (req, res) => {
  try {
    await db.query`DELETE FROM warehouses WHERE id = ${req.params.id}`;
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ===== INVENTORY ADJUSTMENTS =====
router.get("/inventory-adjustments", authenticate, async (req, res) => {
  try {
    await sendPaginatedResults(req, res, `SELECT * FROM inventory_adjustments ORDER BY created_at DESC`, `SELECT COUNT(*) as total FROM inventory_adjustments`);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/inventory-adjustments", authenticate, async (req: AuthRequest, res) => {
  try {
    const { items: lineItems, ...adj } = req.body;
    const id = uuidv4();
    const documentNumber = adj.document_number || adj.documentNumber || adj.reference_number;
    const adjustmentDate = adj.date || new Date().toISOString().split("T")[0];

    if (!documentNumber) {
      return res.status(400).json({ error: "document_number is required" });
    }

    await db.query`INSERT INTO inventory_adjustments (id, document_number, date, reason, status, warehouse_id, created_by, created_at, updated_at) 
      VALUES (${id}, ${documentNumber}, ${adjustmentDate}, ${adj.reason || null}, ${adj.status || 'draft'}, ${adj.warehouse_id || null}, ${req.user!.id}, GETDATE(), GETDATE())`;
    if (lineItems?.length > 0) {
      for (const item of lineItems) {
        const itemId = uuidv4();
        const adjustedQuantity = Number(item.adjusted_quantity ?? item.quantity ?? 0);
        const quantityOnHand = Number(item.quantity_on_hand ?? 0);
        const difference = item.difference != null ? Number(item.difference) : adjustedQuantity - quantityOnHand;
        const movementType = difference >= 0 ? 'in' : 'out';
        const movementCost = Number(item.cost_price ?? 0);

        await db.query`INSERT INTO inventory_adjustment_items (id, adjustment_id, item_id, quantity_on_hand, adjusted_quantity, difference, cost_price) 
          VALUES (${itemId}, ${id}, ${item.item_id}, ${quantityOnHand}, ${adjustedQuantity}, ${difference}, ${item.cost_price || 0})`;

        if (difference !== 0) {
          await updateStock(item.item_id, Math.abs(difference), movementType, id, 'Inventory Adjustment', movementCost);
        }
      }
    }
    const dataResult = await db.query`SELECT * FROM inventory_adjustments WHERE id = ${id}`;
    res.json(dataResult.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ===== STOCK TRANSFERS =====
router.get("/stock-transfers", authenticate, async (req, res) => {
  try {
    await sendPaginatedResults(req, res, `SELECT * FROM stock_transfers ORDER BY created_at DESC`, `SELECT COUNT(*) as total FROM stock_transfers`);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/stock-transfers", authenticate, async (req: AuthRequest, res) => {
  try {
    const { items: lineItems, ...transfer } = req.body;
    const id = uuidv4();
    const documentNumber = transfer.document_number || transfer.documentNumber || transfer.reference_number;
    const transferDate = transfer.date || new Date().toISOString().split("T")[0];

    if (!documentNumber) {
      return res.status(400).json({ error: "document_number is required" });
    }

    if (!transfer.from_warehouse_id || !transfer.to_warehouse_id) {
      return res.status(400).json({ error: "Both source and destination warehouses are required" });
    }

    if (transfer.from_warehouse_id === transfer.to_warehouse_id) {
      return res.status(400).json({ error: "Source and destination warehouses must be different" });
    }

    await db.query`INSERT INTO stock_transfers (id, document_number, date, from_warehouse_id, to_warehouse_id, status, notes, created_by, created_at) 
      VALUES (${id}, ${documentNumber}, ${transferDate}, ${transfer.from_warehouse_id}, ${transfer.to_warehouse_id}, ${transfer.status || 'draft'}, ${transfer.notes || null}, ${req.user!.id}, GETDATE())`;
    if (lineItems?.length > 0) {
      for (const item of lineItems) {
        const itemId = uuidv4();
        await db.query`INSERT INTO stock_transfer_items (id, transfer_id, item_id, quantity) 
          VALUES (${itemId}, ${id}, ${item.item_id}, ${item.quantity})`;

        // Out from source
        await updateStock(item.item_id, item.quantity, 'out', id, 'Stock Transfer', 0, req.user!.id);
        // In to destination (Simplified: updateStock doesn't support warehouse_id yet, but we update global stock)
      }
    }
    const dataResult = await db.query`SELECT * FROM stock_transfers WHERE id = ${id}`;
    res.json(dataResult.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ===== POS SESSIONS =====
router.get("/pos/sessions", authenticate, async (req, res) => {
  try {
    await sendPaginatedResults(req, res, `
      SELECT ps.*, u.username as owner_name
      FROM pos_sessions ps
      LEFT JOIN users u ON ps.opened_by = u.id
      ORDER BY ps.opened_at DESC
    `, `SELECT COUNT(*) as total FROM pos_sessions`);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/pos/sessions/:id", authenticate, async (req, res) => {
  try {
    const sessionResult = await db.query`
      SELECT ps.*, u.username as owner_name
      FROM pos_sessions ps
      LEFT JOIN users u ON ps.opened_by = u.id
      WHERE ps.id = ${req.params.id}
    `;
    const session = sessionResult.recordset[0];
    if (!session) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const orders = await db.query`
      SELECT po.*, c.name as customer_name
      FROM pos_orders po
      LEFT JOIN customers c ON po.customer_id = c.id
      WHERE po.session_id = ${req.params.id}
         OR (
           po.session_id IS NULL
           AND po.created_by = ${session.opened_by}
           AND po.created_at >= ${session.opened_at}
           AND (${session.closed_at} IS NULL OR po.created_at <= ${session.closed_at})
         )
      ORDER BY po.created_at DESC
    `.then((result) => result.recordset);

    res.json({
      ...session,
      order_count: orders.length,
      orders,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/pos/sessions", authenticate, async (req: AuthRequest, res) => {
  try {
    const id = uuidv4();
    const { opening_balance, notes } = req.body;
    await db.query`INSERT INTO pos_sessions (id, opened_by, opened_at, opening_balance, status, notes) VALUES (${id}, ${req.user!.id}, GETDATE(), ${opening_balance || 0}, 'open', ${notes || null})`;
    const dataResult = await db.query`SELECT * FROM pos_sessions WHERE id = ${id}`;
    res.json(dataResult.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/pos/sessions/:id/close", authenticate, async (req, res) => {
  try {
    const { closing_balance, notes } = req.body;
    await db.query`UPDATE pos_sessions SET status = 'closed', closed_at = GETDATE(), closing_balance = ${closing_balance}, notes = COALESCE(${notes}, notes) WHERE id = ${req.params.id}`;
    const dataResult = await db.query`SELECT * FROM pos_sessions WHERE id = ${req.params.id}`;
    res.json(dataResult.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ===== POS ORDERS =====
router.get("/pos/orders", authenticate, async (req, res) => {
  try {
    await sendPaginatedResults(req, res, `
      SELECT po.*, c.name as customer_name, ps.opened_at as session_opened_at
      FROM pos_orders po
      LEFT JOIN customers c ON po.customer_id = c.id
      LEFT JOIN pos_sessions ps ON po.session_id = ps.id
      ORDER BY po.created_at DESC
    `, `SELECT COUNT(*) as total FROM pos_orders`);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/pos/orders/:id", authenticate, async (req, res) => {
  try {
    const orderResult = await db.query`
      SELECT
        po.*,
        c.name as customer_name,
        ps.opened_at as session_opened_at,
        ps.closed_at as session_closed_at,
        ps.status as session_status
      FROM pos_orders po
      LEFT JOIN customers c ON po.customer_id = c.id
      LEFT JOIN pos_sessions ps ON po.session_id = ps.id
      WHERE po.id = ${req.params.id}
    `;
    const order = orderResult.recordset[0];
    if (!order) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const items = await db.query`
      SELECT poi.*, i.sku, i.hsn_code, i.unit
      FROM pos_order_items poi
      LEFT JOIN items i ON poi.item_id = i.id
      WHERE poi.order_id = ${req.params.id}
      ORDER BY poi.item_name ASC
    `.then((result) => result.recordset);

    const payments = await db.query`
      SELECT *
      FROM pos_payments
      WHERE order_id = ${req.params.id}
      ORDER BY created_at ASC
    `.then((result) => result.recordset);

    res.json({
      ...order,
      items,
      payments,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/pos/orders", authenticate, async (req: AuthRequest, res) => {
  try {
    const id = uuidv4();
    const { session_id, customer_id, subtotal, tax_amount, discount, total, items, payments } = req.body;
    const order_number = await generateDocNumber('pos_order');

    await db.query`INSERT INTO pos_orders (id, session_id, customer_id, order_number, subtotal, tax_amount, discount, total, status, created_by, created_at) 
      VALUES (${id}, ${session_id || null}, ${customer_id || null}, ${order_number}, ${subtotal || 0}, ${tax_amount || 0}, ${discount || 0}, ${total || 0}, 'completed', ${req.user!.id}, GETDATE())`;

    if (items && Array.isArray(items)) {
      for (const item of items) {
        await db.query`INSERT INTO pos_order_items (id, order_id, item_id, item_name, quantity, rate, discount, tax_amount, amount) 
          VALUES (${uuidv4()}, ${id}, ${item.item_id}, ${item.item_name}, ${item.quantity || 1}, ${item.rate || 0}, ${item.discount || 0}, ${item.tax_amount || 0}, ${item.amount || 0})`;

        // Update stock
        await updateStock(item.item_id, item.quantity, 'out', id, 'POS Order');
      }
    }

    if (payments && Array.isArray(payments)) {
      for (const pay of payments) {
        await db.query`INSERT INTO pos_payments (id, order_id, payment_mode, amount, reference_number, created_at) 
          VALUES (${uuidv4()}, ${id}, ${pay.payment_mode}, ${pay.amount}, ${pay.reference_number || null}, GETDATE())`;
      }
    }

    // Update session totals if session_id exists
    if (session_id) {
      const cash_total = payments?.filter(p => p.payment_mode === 'cash').reduce((sum, p) => sum + Number(p.amount), 0) || 0;
      const upi_total = payments?.filter(p => p.payment_mode === 'upi').reduce((sum, p) => sum + Number(p.amount), 0) || 0;
      const card_total = payments?.filter(p => p.payment_mode === 'card').reduce((sum, p) => sum + Number(p.amount), 0) || 0;

      await db.query`UPDATE pos_sessions SET total_sales = COALESCE(total_sales, 0) + ${total}, total_cash = COALESCE(total_cash, 0) + ${cash_total}, total_upi = COALESCE(total_upi, 0) + ${upi_total}, total_card = COALESCE(total_card, 0) + ${card_total} WHERE id = ${session_id}`;
    }

    const dataResult = await db.query`SELECT * FROM pos_orders WHERE id = ${id}`;
    res.json(dataResult.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ===== RECURRING INVOICES =====
router.get("/recurring-invoices", authenticate, async (req, res) => {
  try {
    await sendPaginatedResults(req, res, `
      SELECT ri.*, c.name as customer_name, CASE WHEN ri.is_active = 1 THEN 'active' ELSE 'inactive' END as status
      FROM recurring_invoices ri
      LEFT JOIN customers c ON ri.customer_id = c.id
      ORDER BY ri.created_at DESC
    `, `SELECT COUNT(*) as total FROM recurring_invoices`);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/recurring-invoices/:id", authenticate, async (req, res) => {
  try {
    const dataResult = await db.query`
      SELECT
        ri.*,
        c.name as customer_name,
        c.email as customer_email,
        c.phone as customer_phone,
        c.gstin as customer_gstin,
        c.billing_address as customer_address,
        c.state as customer_state,
        i.document_number as base_invoice_number,
        i.date as base_invoice_date,
        CASE WHEN ri.is_active = 1 THEN 'active' ELSE 'inactive' END as status
      FROM recurring_invoices ri
      LEFT JOIN customers c ON ri.customer_id = c.id
      LEFT JOIN invoices i ON ri.base_invoice_id = i.id
      WHERE ri.id = ${req.params.id}
    `;
    const recurringInvoice = dataResult.recordset[0];
    if (!recurringInvoice) { res.status(404).json({ error: "Not found" }); return; }

    const items = recurringInvoice.base_invoice_id
      ? await db.query`
          SELECT
            ii.*,
            it.name as item_name,
            it.hsn_code,
            tr.rate as tax_rate
          FROM invoice_items ii
          LEFT JOIN items it ON ii.item_id = it.id
          LEFT JOIN tax_rates tr ON ii.tax_rate_id = tr.id
          WHERE ii.invoice_id = ${recurringInvoice.base_invoice_id}
          ORDER BY ii.sort_order ASC
        `.then((result) => result.recordset)
      : [];

    const recentInvoices = await db.query`
      SELECT TOP 10
        id,
        document_number,
        date,
        total,
        balance_due,
        status
      FROM invoices
      WHERE customer_id = ${recurringInvoice.customer_id}
      ORDER BY created_at DESC
    `.then((result) => result.recordset);

    res.json({
      ...recurringInvoice,
      items,
      recentInvoices,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/recurring-invoices", authenticate, async (req: AuthRequest, res) => {
  try {
    const id = uuidv4();
    const { customer_id, frequency, start_date, end_date, next_invoice_date, base_invoice_id, subtotal, tax_amount, total, is_active, items } = req.body;
    const today = new Date().toISOString().split("T")[0];
    await db.query`INSERT INTO recurring_invoices (id, customer_id, frequency, start_date, end_date, next_invoice_date, base_invoice_id, is_active, subtotal, tax_amount, total, created_by, created_at)
      VALUES (${id}, ${customer_id}, ${frequency || 'monthly'}, ${start_date || today}, ${end_date || null}, ${next_invoice_date || today}, ${base_invoice_id || null}, ${is_active ?? true}, ${subtotal || 0}, ${tax_amount || 0}, ${total || 0}, ${req.user!.id}, GETDATE())`;

      const dataResult = await db.query`SELECT ri.*, c.name as customer_name, CASE WHEN ri.is_active = 1 THEN 'active' ELSE 'inactive' END as status FROM recurring_invoices ri LEFT JOIN customers c ON ri.customer_id = c.id WHERE ri.id = ${id}`;
      res.json(dataResult.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/recurring-invoices/:id", authenticate, async (req, res) => {
  try {
    await db.query`DELETE FROM recurring_invoices WHERE id = ${req.params.id}`;
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ===== RECURRING BILLS =====
router.get("/recurring-bills", authenticate, async (req, res) => {
  try {
    await sendPaginatedResults(req, res, `
      SELECT rb.*, v.name as vendor_name, CASE WHEN rb.is_active = 1 THEN 'active' ELSE 'inactive' END as status
      FROM recurring_bills rb
      LEFT JOIN vendors v ON rb.vendor_id = v.id
      ORDER BY rb.created_at DESC
    `, `SELECT COUNT(*) as total FROM recurring_bills`);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/recurring-bills/:id", authenticate, async (req, res) => {
  try {
    const dataResult = await db.query`
      SELECT
        rb.*,
        v.name as vendor_name,
        v.email as vendor_email,
        v.phone as vendor_phone,
        v.gstin as vendor_gstin,
        v.address as vendor_address,
        v.state as vendor_state,
        b.document_number as base_bill_number,
        b.date as base_bill_date,
        CASE WHEN rb.is_active = 1 THEN 'active' ELSE 'inactive' END as status
      FROM recurring_bills rb
      LEFT JOIN vendors v ON rb.vendor_id = v.id
      LEFT JOIN bills b ON rb.base_bill_id = b.id
      WHERE rb.id = ${req.params.id}
    `;
    const recurringBill = dataResult.recordset[0];
    if (!recurringBill) { res.status(404).json({ error: "Not found" }); return; }

    const items = recurringBill.base_bill_id
      ? await db.query`
          SELECT
            bi.*,
            i.name as item_name,
            i.hsn_code,
            tr.rate as tax_rate
          FROM bill_items bi
          LEFT JOIN items i ON bi.item_id = i.id
          LEFT JOIN tax_rates tr ON bi.tax_rate_id = tr.id
          WHERE bi.bill_id = ${recurringBill.base_bill_id}
          ORDER BY bi.sort_order ASC
        `.then((result) => result.recordset)
      : [];

    const generatedBillsResult = await db.query`
      SELECT TOP 10
        id,
        document_number,
        date,
        total,
        balance_due,
        status
      FROM bills
      WHERE vendor_id = ${recurringBill.vendor_id}
      ORDER BY created_at DESC
    `;

    res.json({
      ...recurringBill,
      items,
      recentBills: generatedBillsResult.recordset,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/recurring-bills", authenticate, async (req: AuthRequest, res) => {
  try {
    const id = uuidv4();
    const { vendor_id, frequency, start_date, end_date, next_bill_date, base_bill_id, subtotal, tax_amount, total, is_active, items } = req.body;
    const today = new Date().toISOString().split("T")[0];
    await db.query`INSERT INTO recurring_bills (id, vendor_id, frequency, start_date, end_date, next_bill_date, base_bill_id, is_active, subtotal, tax_amount, total, created_by, created_at)
      VALUES (${id}, ${vendor_id}, ${frequency || 'monthly'}, ${start_date || today}, ${end_date || null}, ${next_bill_date || today}, ${base_bill_id || null}, ${is_active ?? true}, ${subtotal || 0}, ${tax_amount || 0}, ${total || 0}, ${req.user!.id}, GETDATE())`;

    const docResult = await db.query`SELECT rb.*, v.name as vendor_name, CASE WHEN rb.is_active = 1 THEN 'active' ELSE 'inactive' END as status FROM recurring_bills rb LEFT JOIN vendors v ON rb.vendor_id = v.id WHERE rb.id = ${id}`;
    res.json(docResult.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/recurring-bills/:id", authenticate, async (req, res) => {
  try {
    await db.query`DELETE FROM recurring_bills WHERE id = ${req.params.id}`;
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ===== INVOICES =====
router.get("/invoices", authenticate, async (req, res) => {
  try {
    await sendPaginatedResults(req, res, `
      SELECT i.*, c.name as customer_name
      FROM invoices i
      LEFT JOIN customers c ON i.customer_id = c.id
      ORDER BY i.created_at DESC
    `, `SELECT COUNT(*) as total FROM invoices`);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/invoices/:id", authenticate, async (req, res) => {
  try {
    const dataResult = await db.query`
      SELECT i.*, c.name as customer_name, c.gstin as customer_gstin, c.billing_address as customer_address
      FROM invoices i 
      LEFT JOIN customers c ON i.customer_id = c.id
      WHERE i.id = ${req.params.id}
    `;
    const data = dataResult.recordset[0];
    if (!data) { res.status(404).json({ error: "Not found" }); return; }

    const items = await db.query`
      SELECT ii.*, it.name as item_name 
      FROM invoice_items ii 
      JOIN items it ON ii.item_id = it.id 
      WHERE ii.invoice_id = ${req.params.id} 
      ORDER BY ii.sort_order
    `.then(res => res.recordset);

    res.json({ ...data, items });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/invoices", authenticate, async (req: AuthRequest, res) => {
  try {
    const id = uuidv4();
    const { customer_id, date, due_date, sales_order_id, reference_id, reference_type, status, subtotal, tax_amount, total, balance_due, notes, terms, items } = req.body;
    const document_number = await generateDocNumber('invoice');

    await db.query`INSERT INTO invoices (id, document_number, date, due_date, customer_id, sales_order_id, reference_id, reference_type, status, subtotal, tax_amount, total, balance_due, notes, terms, created_by, created_at, updated_at) 
      VALUES (${id}, ${document_number}, ${date}, ${due_date || null}, ${customer_id}, ${sales_order_id || null}, ${reference_id || null}, ${reference_type || null}, ${status || 'draft'}, ${subtotal || 0}, ${tax_amount || 0}, ${total || 0}, ${balance_due || total || 0}, ${notes || null}, ${terms || null}, ${req.user!.id}, GETDATE(), GETDATE())`;

    if (items && Array.isArray(items)) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        await db.query`INSERT INTO invoice_items (id, invoice_id, item_id, description, quantity, rate, tax_rate_id, tax_amount, amount, sort_order) 
          VALUES (${uuidv4()}, ${id}, ${item.item_id}, ${item.description || null}, ${item.quantity || 1}, ${item.rate || 0}, ${item.tax_rate_id || null}, ${item.tax_amount || 0}, ${item.amount || 0}, ${i})`;

        // Update stock
        await updateStock(item.item_id, item.quantity, 'out', id, 'Invoice');
      }
    }

    const dataResult = await db.query`SELECT * FROM invoices WHERE id = ${id}`;
    res.json(dataResult.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/invoices/:id", authenticate, async (req, res) => {
  try {
    const { customer_id, date, due_date, sales_order_id, reference_id, reference_type, status, subtotal, tax_amount, total, balance_due, notes, terms, items } = req.body;
    await db.query`UPDATE invoices SET customer_id = COALESCE(${customer_id}, customer_id), date = COALESCE(${date}, date), due_date = COALESCE(${due_date}, due_date), sales_order_id = COALESCE(${sales_order_id}, sales_order_id), reference_id = COALESCE(${reference_id}, reference_id), reference_type = COALESCE(${reference_type}, reference_type), status = COALESCE(${status}, status), subtotal = COALESCE(${subtotal}, subtotal), tax_amount = COALESCE(${tax_amount}, tax_amount), total = COALESCE(${total}, total), balance_due = COALESCE(${balance_due}, balance_due), notes = COALESCE(${notes}, notes), terms = COALESCE(${terms}, terms), updated_at = GETDATE() WHERE id = ${req.params.id}`;

    if (items && Array.isArray(items)) {
      await db.query`DELETE FROM invoice_items WHERE invoice_id = ${req.params.id}`;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        await db.query`INSERT INTO invoice_items (id, invoice_id, item_id, description, quantity, rate, tax_rate_id, tax_amount, amount, sort_order) 
          VALUES (${uuidv4()}, ${req.params.id}, ${item.item_id}, ${item.description || null}, ${item.quantity || 1}, ${item.rate || 0}, ${item.tax_rate_id || null}, ${item.tax_amount || 0}, ${item.amount || 0}, ${i})`;
      }
    }
    const dataResult = await db.query`SELECT * FROM invoices WHERE id = ${req.params.id}`;
    res.json(dataResult.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.patch("/invoices/:id/status", authenticate, async (req, res) => {
  try {
    const { status } = req.body;
    await db.query`UPDATE invoices SET status = ${status}, updated_at = GETDATE() WHERE id = ${req.params.id}`;
    const dataResult = await db.query`SELECT * FROM invoices WHERE id = ${req.params.id}`;
    const data = dataResult.recordset[0];
    if (!data) { res.status(404).json({ error: "Not found" }); return; }
    res.json(data);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});
router.delete("/invoices/:id", authenticate, async (req, res) => {
  try {
    await db.query`DELETE FROM payment_allocations WHERE invoice_id = ${req.params.id}`;
    await db.query`UPDATE payments_received SET invoice_id = NULL WHERE invoice_id = ${req.params.id}`;
    await db.query`UPDATE credit_notes SET invoice_id = NULL WHERE invoice_id = ${req.params.id}`;
    await db.query`DELETE FROM invoice_items WHERE invoice_id = ${req.params.id}`;
    await db.query`DELETE FROM invoices WHERE id = ${req.params.id}`;
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ===== PURCHASE ORDERS =====
router.get("/purchase-orders", authenticate, async (req, res) => {
  try {
    await sendPaginatedResults(req, res, `
      SELECT po.*, v.name as vendor_name
      FROM purchase_orders po
      LEFT JOIN vendors v ON po.vendor_id = v.id
      ORDER BY po.created_at DESC
    `, `SELECT COUNT(*) as total FROM purchase_orders`);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/purchase-orders/:id", authenticate, async (req, res) => {
  try {
    const dataResult = await db.query`
      SELECT po.*, v.name as vendor_name, v.gstin as vendor_gstin, v.address as vendor_address, v.state as vendor_state 
      FROM purchase_orders po 
      LEFT JOIN vendors v ON po.vendor_id = v.id
      WHERE po.id = ${req.params.id}
    `;
    const data = dataResult.recordset[0];
    if (!data) { res.status(404).json({ error: "Not found" }); return; }

    const items = await db.query`
      SELECT poi.*, i.name as item_name 
      FROM purchase_order_items poi 
      LEFT JOIN items i ON poi.item_id = i.id 
      WHERE poi.purchase_order_id = ${req.params.id} 
      ORDER BY poi.sort_order
    `.then(res => res.recordset);

    res.json({ ...data, items });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/purchase-orders", authenticate, async (req: AuthRequest, res) => {
  try {
    const id = uuidv4();
    const { vendor_id, date, expected_delivery, reference_id, reference_type, status, subtotal, tax_amount, total, notes, items } = req.body;
    const document_number = await generateDocNumber('purchase_order');

    await db.query`INSERT INTO purchase_orders (id, document_number, date, expected_delivery, vendor_id, reference_id, reference_type, status, subtotal, tax_amount, total, notes, created_by, created_at, updated_at) 
      VALUES (${id}, ${document_number}, ${date}, ${expected_delivery || null}, ${vendor_id}, ${reference_id || null}, ${reference_type || null}, ${status || 'draft'}, ${subtotal || 0}, ${tax_amount || 0}, ${total || 0}, ${notes || null}, ${req.user!.id}, GETDATE(), GETDATE())`;

    if (items && Array.isArray(items)) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        await db.query`INSERT INTO purchase_order_items (id, purchase_order_id, item_id, description, quantity, rate, tax_rate_id, tax_amount, amount, sort_order) 
          VALUES (${uuidv4()}, ${id}, ${item.item_id}, ${item.description || null}, ${item.quantity || 1}, ${item.rate || 0}, ${item.tax_rate_id || null}, ${item.tax_amount || 0}, ${item.amount || 0}, ${i})`;
      }
    }

    const dataResult = await db.query`SELECT * FROM purchase_orders WHERE id = ${id}`;
    res.json(dataResult.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/purchase-orders/:id", authenticate, async (req, res) => {
  try {
    const { vendor_id, date, expected_delivery, reference_id, reference_type, status, subtotal, tax_amount, total, notes, items } = req.body;
    await db.query`UPDATE purchase_orders SET vendor_id = COALESCE(${vendor_id}, vendor_id), date = COALESCE(${date}, date), expected_delivery = COALESCE(${expected_delivery}, expected_delivery), reference_id = COALESCE(${reference_id}, reference_id), reference_type = COALESCE(${reference_type}, reference_type), status = COALESCE(${status}, status), subtotal = COALESCE(${subtotal}, subtotal), tax_amount = COALESCE(${tax_amount}, tax_amount), total = COALESCE(${total}, total), notes = COALESCE(${notes}, notes), updated_at = GETDATE() WHERE id = ${req.params.id}`;

    if (items && Array.isArray(items)) {
      await db.query`DELETE FROM purchase_order_items WHERE purchase_order_id = ${req.params.id}`;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        await db.query`INSERT INTO purchase_order_items (id, purchase_order_id, item_id, description, quantity, rate, tax_rate_id, tax_amount, amount, sort_order) 
          VALUES (${uuidv4()}, ${req.params.id}, ${item.item_id}, ${item.description || null}, ${item.quantity || 1}, ${item.rate || 0}, ${item.tax_rate_id || null}, ${item.tax_amount || 0}, ${item.amount || 0}, ${i})`;
      }
    }
    const dataResult = await db.query`SELECT * FROM purchase_orders WHERE id = ${req.params.id}`;
    res.json(dataResult.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.patch("/purchase-orders/:id/status", authenticate, async (req, res) => {
  try {
    const { status } = req.body;
    await db.query`UPDATE purchase_orders SET status = ${status}, updated_at = GETDATE() WHERE id = ${req.params.id}`;
    const dataResult = await db.query`SELECT * FROM purchase_orders WHERE id = ${req.params.id}`;
    const data = dataResult.recordset[0];
    if (!data) { res.status(404).json({ error: "Not found" }); return; }
    res.json(data);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});
router.delete("/purchase-orders/:id", authenticate, async (req, res) => {
  try {
    await db.query`UPDATE bills SET purchase_order_id = NULL WHERE purchase_order_id = ${req.params.id}`;
    await db.query`DELETE FROM purchase_order_items WHERE purchase_order_id = ${req.params.id}`;
    await db.query`DELETE FROM purchase_orders WHERE id = ${req.params.id}`;
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ===== BILLS =====
router.get("/bills", authenticate, async (req, res) => {
  try {
    await sendPaginatedResults(req, res, `
      SELECT b.*, v.name as vendor_name, v.gstin as vendor_gstin, v.address as vendor_address, v.state as vendor_state
      FROM bills b
      LEFT JOIN vendors v ON b.vendor_id = v.id
      ORDER BY b.created_at DESC
    `, `SELECT COUNT(*) as total FROM bills`);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/bills/:id", authenticate, async (req, res) => {
  try {
    const dataResult = await db.query`
      SELECT b.*, v.name as vendor_name, v.gstin as vendor_gstin, v.address as vendor_address, v.state as vendor_state 
      FROM bills b 
      LEFT JOIN vendors v ON b.vendor_id = v.id
      WHERE b.id = ${req.params.id}
    `;
    const data = dataResult.recordset[0];
    if (!data) { res.status(404).json({ error: "Not found" }); return; }

    const items = await db.query`
      SELECT bi.*, i.name as item_name 
      FROM bill_items bi 
      LEFT JOIN items i ON bi.item_id = i.id 
      WHERE bi.bill_id = ${req.params.id} 
      ORDER BY bi.sort_order
    `.then(res => res.recordset);

    res.json({ ...data, items });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/bills", authenticate, async (req: AuthRequest, res) => {
  try {
    const id = uuidv4();
    const { vendor_id, date, due_date, purchase_order_id, reference_id, reference_type, status, subtotal, tax_amount, total, balance_due, notes, items } = req.body;
    const document_number = await generateDocNumber('bill');

    await db.query`INSERT INTO bills (id, document_number, date, due_date, vendor_id, purchase_order_id, reference_id, reference_type, status, subtotal, tax_amount, total, balance_due, notes, created_by, created_at, updated_at) 
      VALUES (${id}, ${document_number}, ${date}, ${due_date || null}, ${vendor_id}, ${purchase_order_id || null}, ${reference_id || null}, ${reference_type || null}, ${status || 'draft'}, ${subtotal || 0}, ${tax_amount || 0}, ${total || 0}, ${balance_due || total || 0}, ${notes || null}, ${req.user!.id}, GETDATE(), GETDATE())`;

    if (items && Array.isArray(items)) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        await db.query`INSERT INTO bill_items (id, bill_id, item_id, description, quantity, rate, tax_rate_id, tax_amount, amount, sort_order) 
          VALUES (${uuidv4()}, ${id}, ${item.item_id}, ${item.description || null}, ${item.quantity || 1}, ${item.rate || 0}, ${item.tax_rate_id || null}, ${item.tax_amount || 0}, ${item.amount || 0}, ${i})`;

        // Update stock
        await updateStock(item.item_id, item.quantity, 'in', id, 'Bill', Number(item.rate || 0));
      }
    }

    const dataResult = await db.query`SELECT * FROM bills WHERE id = ${id}`;
    res.json(dataResult.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/bills/:id", authenticate, async (req, res) => {
  try {
    const { vendor_id, date, due_date, purchase_order_id, reference_id, reference_type, status, subtotal, tax_amount, total, balance_due, notes, items } = req.body;
    await db.query`UPDATE bills SET vendor_id = COALESCE(${vendor_id}, vendor_id), date = COALESCE(${date}, date), due_date = COALESCE(${due_date}, due_date), purchase_order_id = COALESCE(${purchase_order_id}, purchase_order_id), reference_id = COALESCE(${reference_id}, reference_id), reference_type = COALESCE(${reference_type}, reference_type), status = COALESCE(${status}, status), subtotal = COALESCE(${subtotal}, subtotal), tax_amount = COALESCE(${tax_amount}, tax_amount), total = COALESCE(${total}, total), balance_due = COALESCE(${balance_due}, balance_due), notes = COALESCE(${notes}, notes), updated_at = GETDATE() WHERE id = ${req.params.id}`;

    if (items && Array.isArray(items)) {
      await db.query`DELETE FROM bill_items WHERE bill_id = ${req.params.id}`;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        await db.query`INSERT INTO bill_items (id, bill_id, item_id, description, quantity, rate, tax_rate_id, tax_amount, amount, sort_order) 
          VALUES (${uuidv4()}, ${req.params.id}, ${item.item_id}, ${item.description || null}, ${item.quantity || 1}, ${item.rate || 0}, ${item.tax_rate_id || null}, ${item.tax_amount || 0}, ${item.amount || 0}, ${i})`;
      }
    }
    const dataResult = await db.query`SELECT * FROM bills WHERE id = ${req.params.id}`;
    res.json(dataResult.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.patch("/bills/:id/status", authenticate, async (req, res) => {
  try {
    const { status } = req.body;
    await db.query`UPDATE bills SET status = ${status}, updated_at = GETDATE() WHERE id = ${req.params.id}`;
    const dataResult = await db.query`SELECT * FROM bills WHERE id = ${req.params.id}`;
    const data = dataResult.recordset[0];
    if (!data) { res.status(404).json({ error: "Not found" }); return; }
    res.json(data);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});
router.delete("/bills/:id", authenticate, async (req, res) => {
  try {
    await db.query`UPDATE payments_made SET bill_id = NULL WHERE bill_id = ${req.params.id}`;
    await db.query`UPDATE vendor_credits SET bill_id = NULL WHERE bill_id = ${req.params.id}`;
    await db.query`UPDATE purchase_returns SET bill_id = NULL WHERE bill_id = ${req.params.id}`;
    await db.query`DELETE FROM bill_items WHERE bill_id = ${req.params.id}`;
    await db.query`DELETE FROM bills WHERE id = ${req.params.id}`;
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ===== CREDIT NOTES =====
router.get("/credit-notes", authenticate, async (req, res) => {
  try {
    await sendPaginatedResults(req, res, `
      SELECT cn.*, c.name as customer_name, c.gstin as customer_gstin, c.billing_address as customer_address, c.state as customer_state
      FROM credit_notes cn
      LEFT JOIN customers c ON cn.customer_id = c.id
      ORDER BY cn.created_at DESC
    `, `SELECT COUNT(*) as total FROM credit_notes`);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/credit-notes/:id", authenticate, async (req, res) => {
  try {
    const dataResult = await db.query`
      SELECT cn.*, c.name as customer_name, c.gstin as customer_gstin, c.billing_address as customer_address, c.state as customer_state 
      FROM credit_notes cn 
      LEFT JOIN customers c ON cn.customer_id = c.id
      WHERE cn.id = ${req.params.id}
    `;
    const data = dataResult.recordset[0];
    if (!data) { res.status(404).json({ error: "Not found" }); return; }

    const items = await db.query`
      SELECT cni.*, i.name as item_name 
      FROM credit_note_items cni 
      LEFT JOIN items i ON cni.item_id = i.id 
      WHERE cni.credit_note_id = ${req.params.id} 
      ORDER BY cni.sort_order
    `.then(res => res.recordset);

    res.json({ ...data, items });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/credit-notes", authenticate, async (req: AuthRequest, res) => {
  try {
    const id = uuidv4();
    const { customer_id, date, invoice_id, reference_id, reference_type, status, subtotal, tax_amount, total, reason, items } = req.body;
    const document_number = await generateDocNumber('credit_note');

    await db.query`INSERT INTO credit_notes (id, document_number, date, customer_id, invoice_id, reference_id, reference_type, status, subtotal, tax_amount, total, reason, created_by, created_at, updated_at) 
      VALUES (${id}, ${document_number}, ${date}, ${customer_id}, ${invoice_id || null}, ${reference_id || null}, ${reference_type || null}, ${status || 'draft'}, ${subtotal || 0}, ${tax_amount || 0}, ${total || 0}, ${reason || null}, ${req.user!.id}, GETDATE(), GETDATE())`;

    if (items && Array.isArray(items)) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        await db.query`INSERT INTO credit_note_items (id, credit_note_id, item_id, description, quantity, rate, tax_rate_id, tax_amount, amount, sort_order) 
          VALUES (${uuidv4()}, ${id}, ${item.item_id}, ${item.description || null}, ${item.quantity || 1}, ${item.rate || 0}, ${item.tax_rate_id || null}, ${item.tax_amount || 0}, ${item.amount || 0}, ${i})`;

        // Update stock
        await updateStock(item.item_id, item.quantity, 'in', id, 'Credit Note');
      }
    }

    const dataResult = await db.query`SELECT * FROM credit_notes WHERE id = ${id}`;
    res.json(dataResult.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/credit-notes/:id", authenticate, async (req, res) => {
  try {
    const { customer_id, date, invoice_id, reference_id, reference_type, status, subtotal, tax_amount, total, reason, items } = req.body;
    await db.query`UPDATE credit_notes SET customer_id = COALESCE(${customer_id}, customer_id), date = COALESCE(${date}, date), invoice_id = COALESCE(${invoice_id}, invoice_id), reference_id = COALESCE(${reference_id}, reference_id), reference_type = COALESCE(${reference_type}, reference_type), status = COALESCE(${status}, status), subtotal = COALESCE(${subtotal}, subtotal), tax_amount = COALESCE(${tax_amount}, tax_amount), total = COALESCE(${total}, total), reason = COALESCE(${reason}, reason), updated_at = GETDATE() WHERE id = ${req.params.id}`;

    if (items && Array.isArray(items)) {
      await db.query`DELETE FROM credit_note_items WHERE credit_note_id = ${req.params.id}`;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        await db.query`INSERT INTO credit_note_items (id, credit_note_id, item_id, description, quantity, rate, tax_rate_id, tax_amount, amount, sort_order) 
          VALUES (${uuidv4()}, ${req.params.id}, ${item.item_id}, ${item.description || null}, ${item.quantity || 1}, ${item.rate || 0}, ${item.tax_rate_id || null}, ${item.tax_amount || 0}, ${item.amount || 0}, ${i})`;
      }
    }
    const dataResult = await db.query`SELECT * FROM credit_notes WHERE id = ${req.params.id}`;
    res.json(dataResult.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/credit-notes/:id", authenticate, async (req, res) => {
  try {
    await db.query`DELETE FROM credit_note_items WHERE credit_note_id = ${req.params.id}`;
    await db.query`DELETE FROM credit_notes WHERE id = ${req.params.id}`;
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});


// ===== VENDOR CREDITS =====
router.get("/vendor-credits", authenticate, async (req, res) => {
  try {
    await sendPaginatedResults(req, res, `
      SELECT vc.*, v.name as vendor_name
      FROM vendor_credits vc
      LEFT JOIN vendors v ON vc.vendor_id = v.id
      ORDER BY vc.created_at DESC
    `, `SELECT COUNT(*) as total FROM vendor_credits`);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/vendor-credits/:id", authenticate, async (req, res) => {
  try {
    const dataResult = await db.query`
      SELECT vc.*, v.name as vendor_name, v.gstin as vendor_gstin, v.address as vendor_address, v.state as vendor_state
      FROM vendor_credits vc
      LEFT JOIN vendors v ON vc.vendor_id = v.id
      WHERE vc.id = ${req.params.id}
    `;
    const data = dataResult.recordset[0];
    if (!data) { res.status(404).json({ error: "Not found" }); return; }

    const items = await db.query`
      SELECT vci.*, i.name as item_name
      FROM vendor_credit_items vci
      LEFT JOIN items i ON vci.item_id = i.id
      WHERE vci.vendor_credit_id = ${req.params.id}
      ORDER BY vci.sort_order
    `.then(res => res.recordset);

    res.json({ ...data, items });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/vendor-credits", authenticate, async (req: AuthRequest, res) => {
  try {
    const id = uuidv4();
    const { vendor_id, date, bill_id, reference_id, reference_type, status, subtotal, tax_amount, total, reason, items } = req.body;
    const document_number = await generateDocNumber('vendor_credit');

    await db.query`INSERT INTO vendor_credits (id, document_number, date, vendor_id, bill_id, reference_id, reference_type, status, subtotal, tax_amount, total, reason, created_by, created_at, updated_at)
      VALUES (${id}, ${document_number}, ${date || new Date().toISOString().split("T")[0]}, ${vendor_id}, ${bill_id || null}, ${reference_id || null}, ${reference_type || null}, ${status || 'draft'}, ${subtotal || 0}, ${tax_amount || 0}, ${total || 0}, ${reason || null}, ${req.user!.id}, GETDATE(), GETDATE())`;

    if (items && Array.isArray(items)) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        await db.query`INSERT INTO vendor_credit_items (id, vendor_credit_id, item_id, description, quantity, rate, tax_rate_id, tax_amount, amount, sort_order)
          VALUES (${uuidv4()}, ${id}, ${item.item_id}, ${item.description || null}, ${item.quantity || 1}, ${item.rate || 0}, ${item.tax_rate_id || null}, ${item.tax_amount || 0}, ${item.amount || 0}, ${i})`;

        await updateStock(item.item_id, item.quantity, 'in', id, 'Vendor Credit', Number(item.rate || 0));
      }
    }

    const docResult = await db.query`SELECT * FROM vendor_credits WHERE id = ${id}`;
    res.json(docResult.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/vendor-credits/:id", authenticate, async (req, res) => {
  try {
    const { vendor_id, date, bill_id, reference_id, reference_type, status, subtotal, tax_amount, total, reason, items } = req.body;
    await db.query`UPDATE vendor_credits SET vendor_id = COALESCE(${vendor_id}, vendor_id), date = COALESCE(${date}, date), bill_id = COALESCE(${bill_id}, bill_id), reference_id = COALESCE(${reference_id}, reference_id), reference_type = COALESCE(${reference_type}, reference_type), status = COALESCE(${status}, status), subtotal = COALESCE(${subtotal}, subtotal), tax_amount = COALESCE(${tax_amount}, tax_amount), total = COALESCE(${total}, total), reason = COALESCE(${reason}, reason), updated_at = GETDATE() WHERE id = ${req.params.id}`;

    if (items && Array.isArray(items)) {
      await db.query`DELETE FROM vendor_credit_items WHERE vendor_credit_id = ${req.params.id}`;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        await db.query`INSERT INTO vendor_credit_items (id, vendor_credit_id, item_id, description, quantity, rate, tax_rate_id, tax_amount, amount, sort_order)
          VALUES (${uuidv4()}, ${req.params.id}, ${item.item_id}, ${item.description || null}, ${item.quantity || 1}, ${item.rate || 0}, ${item.tax_rate_id || null}, ${item.tax_amount || 0}, ${item.amount || 0}, ${i})`;
      }
    }

    const docResult = await db.query`SELECT * FROM vendor_credits WHERE id = ${req.params.id}`;
    res.json(docResult.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/vendor-credits/:id", authenticate, async (req, res) => {
  try {
    await db.query`DELETE FROM vendor_credit_items WHERE vendor_credit_id = ${req.params.id}`;
    await db.query`DELETE FROM vendor_credits WHERE id = ${req.params.id}`;
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});
// ===== QUOTATIONS =====
router.get("/quotations", authenticate, async (req, res) => {
  try {
    await sendPaginatedResults(req, res, `
      SELECT q.*, c.name as customer_name
      FROM quotations q
      LEFT JOIN customers c ON q.customer_id = c.id
      ORDER BY q.created_at DESC
    `, `SELECT COUNT(*) as total FROM quotations`);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/quotations/:id", authenticate, async (req, res) => {
  try {
    const dataResult = await db.query`
      SELECT q.*, c.name as customer_name, c.gstin as customer_gstin, c.billing_address as customer_address
      FROM quotations q 
      LEFT JOIN customers c ON q.customer_id = c.id
      WHERE q.id = ${req.params.id}
    `;
    const data = dataResult.recordset[0];
    if (!data) { res.status(404).json({ error: "Not found" }); return; }

    const items = await db.query`
      SELECT qi.*, i.name as item_name 
      FROM quotation_items qi 
      LEFT JOIN items i ON qi.item_id = i.id 
      WHERE qi.quotation_id = ${req.params.id} 
      ORDER BY qi.sort_order
    `.then(res => res.recordset);

    res.json({ ...data, items });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/quotations", authenticate, async (req: AuthRequest, res) => {
  try {
    const id = uuidv4();
    const { customer_id, date, valid_until, reference_id, reference_type, status, subtotal, tax_amount, total, notes, terms, items } = req.body;
    const document_number = await generateDocNumber('quotation');

    await db.query`INSERT INTO quotations (id, document_number, date, valid_until, customer_id, reference_id, reference_type, status, subtotal, tax_amount, total, notes, terms, created_by, created_at, updated_at) 
      VALUES (${id}, ${document_number}, ${date}, ${valid_until || null}, ${customer_id}, ${reference_id || null}, ${reference_type || null}, ${status || 'draft'}, ${subtotal || 0}, ${tax_amount || 0}, ${total || 0}, ${notes || null}, ${terms || null}, ${req.user!.id}, GETDATE(), GETDATE())`;

    if (items && Array.isArray(items)) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        await db.query`INSERT INTO quotation_items (id, quotation_id, item_id, description, quantity, rate, tax_rate_id, tax_amount, amount, sort_order) 
          VALUES (${uuidv4()}, ${id}, ${item.item_id}, ${item.description || null}, ${item.quantity || 1}, ${item.rate || 0}, ${item.tax_rate_id || null}, ${item.tax_amount || 0}, ${item.amount || 0}, ${i})`;
      }
    }

    const dataResult = await db.query`SELECT * FROM quotations WHERE id = ${id}`;
    res.json(dataResult.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/quotations/:id", authenticate, async (req, res) => {
  try {
    const { customer_id, date, valid_until, reference_id, reference_type, status, subtotal, tax_amount, total, notes, terms, items } = req.body;
    await db.query`UPDATE quotations SET customer_id = COALESCE(${customer_id}, customer_id), date = COALESCE(${date}, date), valid_until = COALESCE(${valid_until}, valid_until), reference_id = COALESCE(${reference_id}, reference_id), reference_type = COALESCE(${reference_type}, reference_type), status = COALESCE(${status}, status), subtotal = COALESCE(${subtotal}, subtotal), tax_amount = COALESCE(${tax_amount}, tax_amount), total = COALESCE(${total}, total), notes = COALESCE(${notes}, notes), terms = COALESCE(${terms}, terms), updated_at = GETDATE() WHERE id = ${req.params.id}`;

    if (items && Array.isArray(items)) {
      await db.query`DELETE FROM quotation_items WHERE quotation_id = ${req.params.id}`;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        await db.query`INSERT INTO quotation_items (id, quotation_id, item_id, description, quantity, rate, tax_rate_id, tax_amount, amount, sort_order) 
          VALUES (${uuidv4()}, ${req.params.id}, ${item.item_id}, ${item.description || null}, ${item.quantity || 1}, ${item.rate || 0}, ${item.tax_rate_id || null}, ${item.tax_amount || 0}, ${item.amount || 0}, ${i})`;
      }
    }
    const dataResult = await db.query`SELECT * FROM quotations WHERE id = ${req.params.id}`;
    res.json(dataResult.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.patch("/quotations/:id/status", authenticate, async (req, res) => {
  try {
    const { status } = req.body;
    await db.query`UPDATE quotations SET status = ${status}, updated_at = GETDATE() WHERE id = ${req.params.id}`;
    const dataResult = await db.query`SELECT * FROM quotations WHERE id = ${req.params.id}`;
    const data = dataResult.recordset[0];
    if (!data) { res.status(404).json({ error: "Not found" }); return; }
    res.json(data);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});
router.delete("/quotations/:id", authenticate, async (req, res) => {
  try {
    await db.query`UPDATE sales_orders SET quotation_id = NULL WHERE quotation_id = ${req.params.id}`;
    await db.query`DELETE FROM quotation_items WHERE quotation_id = ${req.params.id}`;
    await db.query`DELETE FROM quotations WHERE id = ${req.params.id}`;
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ===== SALES ORDERS =====
router.get("/sales-orders", authenticate, async (req, res) => {
  try {
    await sendPaginatedResults(req, res, `
      SELECT so.*, c.name as customer_name, c.gstin as customer_gstin, c.billing_address as customer_address
      FROM sales_orders so
      LEFT JOIN customers c ON so.customer_id = c.id
      ORDER BY so.created_at DESC
    `, `SELECT COUNT(*) as total FROM sales_orders`);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/sales-orders/:id", authenticate, async (req, res) => {
  try {
    const dataResult = await db.query`
      SELECT so.*, c.name as customer_name, c.gstin as customer_gstin, c.billing_address as customer_address 
      FROM sales_orders so 
      LEFT JOIN customers c ON so.customer_id = c.id
      WHERE so.id = ${req.params.id}
    `;
    const data = dataResult.recordset[0];
    if (!data) { res.status(404).json({ error: "Not found" }); return; }

    const items = await db.query`
      SELECT soi.*, i.name as item_name 
      FROM sales_order_items soi 
      LEFT JOIN items i ON soi.item_id = i.id 
      WHERE soi.sales_order_id = ${req.params.id} 
      ORDER BY soi.sort_order
    `.then(res => res.recordset);

    res.json({ ...data, items });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/sales-orders", authenticate, async (req: AuthRequest, res) => {
  try {
    const id = uuidv4();
    const { customer_id, date, expected_delivery, quotation_id, reference_id, reference_type, status, subtotal, tax_amount, total, notes, items } = req.body;
    const document_number = await generateDocNumber('sales_order');

    await db.query`INSERT INTO sales_orders (id, document_number, date, expected_delivery, customer_id, quotation_id, reference_id, reference_type, status, subtotal, tax_amount, total, notes, created_by, created_at, updated_at) 
      VALUES (${id}, ${document_number}, ${date}, ${expected_delivery || null}, ${customer_id}, ${quotation_id || null}, ${reference_id || null}, ${reference_type || null}, ${status || 'confirmed'}, ${subtotal || 0}, ${tax_amount || 0}, ${total || 0}, ${notes || null}, ${req.user!.id}, GETDATE(), GETDATE())`;

    if (items && Array.isArray(items)) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        await db.query`INSERT INTO sales_order_items (id, sales_order_id, item_id, description, quantity, rate, tax_rate_id, tax_amount, amount, sort_order) 
          VALUES (${uuidv4()}, ${id}, ${item.item_id}, ${item.description || null}, ${item.quantity || 1}, ${item.rate || 0}, ${item.tax_rate_id || null}, ${item.tax_amount || 0}, ${item.amount || 0}, ${i})`;
      }
    }

    const dataResult = await db.query`SELECT * FROM sales_orders WHERE id = ${id}`;
    res.json(dataResult.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/sales-orders/:id", authenticate, async (req, res) => {
  try {
    const { customer_id, date, expected_delivery, quotation_id, reference_id, reference_type, status, subtotal, tax_amount, total, notes, items } = req.body;
    await db.query`UPDATE sales_orders SET customer_id = COALESCE(${customer_id}, customer_id), date = COALESCE(${date}, date), expected_delivery = COALESCE(${expected_delivery}, expected_delivery), quotation_id = COALESCE(${quotation_id}, quotation_id), reference_id = COALESCE(${reference_id}, reference_id), reference_type = COALESCE(${reference_type}, reference_type), status = COALESCE(${status}, status), subtotal = COALESCE(${subtotal}, subtotal), tax_amount = COALESCE(${tax_amount}, tax_amount), total = COALESCE(${total}, total), notes = COALESCE(${notes}, notes), updated_at = GETDATE() WHERE id = ${req.params.id}`;

    if (items && Array.isArray(items)) {
      await db.query`DELETE FROM sales_order_items WHERE sales_order_id = ${req.params.id}`;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        await db.query`INSERT INTO sales_order_items (id, sales_order_id, item_id, description, quantity, rate, tax_rate_id, tax_amount, amount, sort_order) 
          VALUES (${uuidv4()}, ${req.params.id}, ${item.item_id}, ${item.description || null}, ${item.quantity || 1}, ${item.rate || 0}, ${item.tax_rate_id || null}, ${item.tax_amount || 0}, ${item.amount || 0}, ${i})`;
      }
    }
    const dataResult = await db.query`SELECT * FROM sales_orders WHERE id = ${req.params.id}`;
    res.json(dataResult.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.patch("/sales-orders/:id/status", authenticate, async (req, res) => {
  try {
    const { status } = req.body;
    await db.query`UPDATE sales_orders SET status = ${status}, updated_at = GETDATE() WHERE id = ${req.params.id}`;
    const dataResult = await db.query`SELECT * FROM sales_orders WHERE id = ${req.params.id}`;
    const data = dataResult.recordset[0];
    if (!data) { res.status(404).json({ error: "Not found" }); return; }
    res.json(data);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});
router.delete("/sales-orders/:id", authenticate, async (req, res) => {
  try {
    await db.query`UPDATE delivery_challans SET sales_order_id = NULL WHERE sales_order_id = ${req.params.id}`;
    await db.query`UPDATE invoices SET sales_order_id = NULL WHERE sales_order_id = ${req.params.id}`;
    await db.query`DELETE FROM sales_order_items WHERE sales_order_id = ${req.params.id}`;
    await db.query`DELETE FROM sales_orders WHERE id = ${req.params.id}`;
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ===== RECURRING INVOICES =====
router.get("/recurring-invoices", authenticate, async (req, res) => {
  try {
    await sendPaginatedResults(req, res, `
      SELECT ri.*, c.name as customer_name, CASE WHEN ri.is_active = 1 THEN 'active' ELSE 'inactive' END as status
      FROM recurring_invoices ri
      LEFT JOIN customers c ON ri.customer_id = c.id
      ORDER BY ri.created_at DESC
    `, `SELECT COUNT(*) as total FROM recurring_invoices`);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/recurring-invoices/:id", authenticate, async (req, res) => {
  try {
    const dataResult = await db.query`
      SELECT
        ri.*,
        c.name as customer_name,
        c.email as customer_email,
        c.phone as customer_phone,
        c.gstin as customer_gstin,
        c.billing_address as customer_address,
        c.state as customer_state,
        i.document_number as base_invoice_number,
        i.date as base_invoice_date,
        CASE WHEN ri.is_active = 1 THEN 'active' ELSE 'inactive' END as status
      FROM recurring_invoices ri
      LEFT JOIN customers c ON ri.customer_id = c.id
      LEFT JOIN invoices i ON ri.base_invoice_id = i.id
      WHERE ri.id = ${req.params.id}
    `;
    const recurringInvoice = dataResult.recordset[0];
    if (!recurringInvoice) { res.status(404).json({ error: "Not found" }); return; }

    const items = recurringInvoice.base_invoice_id
      ? await db.query`
          SELECT
            ii.*,
            it.name as item_name,
            it.hsn_code,
            tr.rate as tax_rate
          FROM invoice_items ii
          LEFT JOIN items it ON ii.item_id = it.id
          LEFT JOIN tax_rates tr ON ii.tax_rate_id = tr.id
          WHERE ii.invoice_id = ${recurringInvoice.base_invoice_id}
          ORDER BY ii.sort_order ASC
        `.then((result) => result.recordset)
      : [];

    const recentInvoices = await db.query`
      SELECT TOP 10
        id,
        document_number,
        date,
        total,
        balance_due,
        status
      FROM invoices
      WHERE customer_id = ${recurringInvoice.customer_id}
      ORDER BY created_at DESC
    `.then((result) => result.recordset);

    res.json({
      ...recurringInvoice,
      items,
      recentInvoices,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/recurring-invoices", authenticate, async (req: AuthRequest, res) => {
  try {
    const id = uuidv4();
    const { customer_id, frequency, start_date, end_date, next_invoice_date, base_invoice_id, subtotal, tax_amount, total, is_active, items } = req.body;
    const today = new Date().toISOString().split("T")[0];
    await db.query`INSERT INTO recurring_invoices (id, customer_id, frequency, start_date, end_date, next_invoice_date, base_invoice_id, is_active, subtotal, tax_amount, total, created_by, created_at) 
      VALUES (${id}, ${customer_id}, ${frequency || 'monthly'}, ${start_date || today}, ${end_date || null}, ${next_invoice_date || today}, ${base_invoice_id || null}, ${is_active ?? true}, ${subtotal || 0}, ${tax_amount || 0}, ${total || 0}, ${req.user!.id}, GETDATE())`;

      const docResult = await db.query`SELECT ri.*, c.name as customer_name, CASE WHEN ri.is_active = 1 THEN 'active' ELSE 'inactive' END as status FROM recurring_invoices ri LEFT JOIN customers c ON ri.customer_id = c.id WHERE ri.id = ${id}`;
      res.json(docResult.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/recurring-invoices/:id", authenticate, async (req, res) => {
  try {
    await db.query`DELETE FROM recurring_invoices WHERE id = ${req.params.id}`;
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ===== RECURRING BILLS =====
router.get("/recurring-bills", authenticate, async (req, res) => {
  try {
    await sendPaginatedResults(req, res, `
      SELECT rb.*, v.name as vendor_name, CASE WHEN rb.is_active = 1 THEN 'active' ELSE 'inactive' END as status
      FROM recurring_bills rb
      LEFT JOIN vendors v ON rb.vendor_id = v.id
      ORDER BY rb.created_at DESC
    `, `SELECT COUNT(*) as total FROM recurring_bills`);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/recurring-bills/:id", authenticate, async (req, res) => {
  try {
    const dataResult = await db.query`
      SELECT
        rb.*,
        v.name as vendor_name,
        v.email as vendor_email,
        v.phone as vendor_phone,
        v.gstin as vendor_gstin,
        v.address as vendor_address,
        v.state as vendor_state,
        b.document_number as base_bill_number,
        b.date as base_bill_date,
        CASE WHEN rb.is_active = 1 THEN 'active' ELSE 'inactive' END as status
      FROM recurring_bills rb
      LEFT JOIN vendors v ON rb.vendor_id = v.id
      LEFT JOIN bills b ON rb.base_bill_id = b.id
      WHERE rb.id = ${req.params.id}
    `;
    const recurringBill = dataResult.recordset[0];
    if (!recurringBill) { res.status(404).json({ error: "Not found" }); return; }

    const items = recurringBill.base_bill_id
      ? await db.query`
          SELECT
            bi.*,
            i.name as item_name,
            i.hsn_code,
            tr.rate as tax_rate
          FROM bill_items bi
          LEFT JOIN items i ON bi.item_id = i.id
          LEFT JOIN tax_rates tr ON bi.tax_rate_id = tr.id
          WHERE bi.bill_id = ${recurringBill.base_bill_id}
          ORDER BY bi.sort_order ASC
        `.then((result) => result.recordset)
      : [];

    const generatedBillsResult = await db.query`
      SELECT TOP 10
        id,
        document_number,
        date,
        total,
        balance_due,
        status
      FROM bills
      WHERE vendor_id = ${recurringBill.vendor_id}
      ORDER BY created_at DESC
    `;

    res.json({
      ...recurringBill,
      items,
      recentBills: generatedBillsResult.recordset,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/recurring-bills", authenticate, async (req: AuthRequest, res) => {
  try {
    const id = uuidv4();
    const { vendor_id, frequency, start_date, end_date, next_bill_date, base_bill_id, subtotal, tax_amount, total, is_active, items } = req.body;
    const today = new Date().toISOString().split("T")[0];
    await db.query`INSERT INTO recurring_bills (id, vendor_id, frequency, start_date, end_date, next_bill_date, base_bill_id, is_active, subtotal, tax_amount, total, created_by, created_at) 
      VALUES (${id}, ${vendor_id}, ${frequency || 'monthly'}, ${start_date || today}, ${end_date || null}, ${next_bill_date || today}, ${base_bill_id || null}, ${is_active ?? true}, ${subtotal || 0}, ${tax_amount || 0}, ${total || 0}, ${req.user!.id}, GETDATE())`;

    const docResult = await db.query`SELECT rb.*, v.name as vendor_name, CASE WHEN rb.is_active = 1 THEN 'active' ELSE 'inactive' END as status FROM recurring_bills rb LEFT JOIN vendors v ON rb.vendor_id = v.id WHERE rb.id = ${id}`;
    res.json(docResult.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/recurring-bills/:id", authenticate, async (req, res) => {
  try {
    await db.query`DELETE FROM recurring_bills WHERE id = ${req.params.id}`;
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ===== SALES RETURNS =====
router.get("/sales-returns", authenticate, async (req, res) => {
  try {
    await sendPaginatedResults(req, res, `
      SELECT sr.*, c.name as customer_name
      FROM sales_returns sr
      LEFT JOIN customers c ON sr.customer_id = c.id
      ORDER BY sr.created_at DESC
    `, `SELECT COUNT(*) as total FROM sales_returns`);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/sales-returns/:id", authenticate, async (req, res) => {
  try {
    const dataResult = await db.query`
      SELECT sr.*, c.name as customer_name, c.gstin as customer_gstin, c.billing_address as customer_address, c.state as customer_state
      FROM sales_returns sr
      LEFT JOIN customers c ON sr.customer_id = c.id
      WHERE sr.id = ${req.params.id}
    `;
    const data = dataResult.recordset[0];
    if (!data) { res.status(404).json({ error: "Not found" }); return; }

    const items = await db.query`
      SELECT sri.*, i.name as item_name, i.hsn_code
      FROM sales_return_items sri
      LEFT JOIN items i ON sri.item_id = i.id
      WHERE sri.sales_return_id = ${req.params.id}
    `.then(res => res.recordset);

    res.json({ ...data, items });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});
router.post("/sales-returns", authenticate, async (req: AuthRequest, res) => {
  try {
    const id = uuidv4();
    const { customer_id, invoice_id, date, subtotal, tax_amount, total, reason, notes, status, items } = req.body;
    const document_number = await generateDocNumber('sales_return');
    const today = new Date().toISOString().split("T")[0];

    await db.query`INSERT INTO sales_returns (id, document_number, customer_id, invoice_id, date, subtotal, tax_amount, total, reason, notes, status, created_by, created_at, updated_at) 
      VALUES (${id}, ${document_number}, ${customer_id}, ${invoice_id || null}, ${date || today}, ${subtotal || 0}, ${tax_amount || 0}, ${total || 0}, ${reason || null}, ${notes || null}, ${status || 'received'}, ${req.user!.id}, GETDATE(), GETDATE())`;

    if (items && Array.isArray(items)) {
      for (const item of items) {
        await db.query`INSERT INTO sales_return_items (id, sales_return_id, item_id, quantity, rate, tax_amount, total) 
          VALUES (${uuidv4()}, ${id}, ${item.item_id}, ${item.quantity}, ${item.rate}, ${item.tax_amount || 0}, ${item.total || item.amount || ((item.quantity || 0) * (item.rate || 0)) || 0})`;

        await updateStock(item.item_id, item.quantity, 'in', id, 'Sales Return');
      }
    }
    const docResult = await db.query`SELECT * FROM sales_returns WHERE id = ${id}`;
    res.json(docResult.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/sales-returns/:id", authenticate, async (req, res) => {
  try {
    const { customer_id, invoice_id, date, subtotal, tax_amount, total, reason, notes, status, items } = req.body;
    await db.query`UPDATE sales_returns SET customer_id = COALESCE(${customer_id}, customer_id), invoice_id = COALESCE(${invoice_id}, invoice_id), date = COALESCE(${date}, date), subtotal = COALESCE(${subtotal}, subtotal), tax_amount = COALESCE(${tax_amount}, tax_amount), total = COALESCE(${total}, total), reason = COALESCE(${reason}, reason), notes = COALESCE(${notes}, notes), status = COALESCE(${status}, status), updated_at = GETDATE() WHERE id = ${req.params.id}`;

    if (items && Array.isArray(items)) {
      await db.query`DELETE FROM sales_return_items WHERE sales_return_id = ${req.params.id}`;
      for (const item of items) {
        await db.query`INSERT INTO sales_return_items (id, sales_return_id, item_id, quantity, rate, tax_amount, total) 
          VALUES (${uuidv4()}, ${req.params.id}, ${item.item_id}, ${item.quantity}, ${item.rate}, ${item.tax_amount || 0}, ${item.total || item.amount || ((item.quantity || 0) * (item.rate || 0)) || 0})`;
      }
    }
    const docResult = await db.query`SELECT * FROM sales_returns WHERE id = ${req.params.id}`;
    res.json(docResult.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/sales-returns/:id", authenticate, async (req, res) => {
  try {
    await db.query`DELETE FROM sales_return_items WHERE sales_return_id = ${req.params.id}`;
    await db.query`DELETE FROM sales_returns WHERE id = ${req.params.id}`;
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ===== PURCHASE RETURNS =====
router.get("/purchase-returns", authenticate, async (req, res) => {
  try {
    await sendPaginatedResults(req, res, `
      SELECT pr.*, v.name as vendor_name
      FROM purchase_returns pr
      LEFT JOIN vendors v ON pr.vendor_id = v.id
      ORDER BY pr.created_at DESC
    `, `SELECT COUNT(*) as total FROM purchase_returns`);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/purchase-returns/:id", authenticate, async (req, res) => {
  try {
    const dataResult = await db.query`
      SELECT pr.*, v.name as vendor_name, v.gstin as vendor_gstin, v.address as vendor_address, v.state as vendor_state
      FROM purchase_returns pr
      LEFT JOIN vendors v ON pr.vendor_id = v.id
      WHERE pr.id = ${req.params.id}
    `;
    const data = dataResult.recordset[0];
    if (!data) { res.status(404).json({ error: "Not found" }); return; }

    const items = await db.query`
      SELECT pri.*, i.name as item_name, i.hsn_code
      FROM purchase_return_items pri
      LEFT JOIN items i ON pri.item_id = i.id
      WHERE pri.purchase_return_id = ${req.params.id}
    `.then(res => res.recordset);

    res.json({ ...data, items });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});
router.post("/purchase-returns", authenticate, async (req: AuthRequest, res) => {
  try {
    const id = uuidv4();
    const { vendor_id, bill_id, date, subtotal, tax_amount, total, reason, notes, status, items } = req.body;
    const document_number = await generateDocNumber('purchase_return');
    const today = new Date().toISOString().split("T")[0];

    await db.query`INSERT INTO purchase_returns (id, document_number, vendor_id, bill_id, date, subtotal, tax_amount, total, reason, notes, status, created_by, created_at, updated_at) 
      VALUES (${id}, ${document_number}, ${vendor_id}, ${bill_id || null}, ${date || today}, ${subtotal || 0}, ${tax_amount || 0}, ${total || 0}, ${reason || null}, ${notes || null}, ${status || 'dispatched'}, ${req.user!.id}, GETDATE(), GETDATE())`;

    if (items && Array.isArray(items)) {
      for (const item of items) {
        await db.query`INSERT INTO purchase_return_items (id, purchase_return_id, item_id, quantity, rate, tax_amount, total) 
          VALUES (${uuidv4()}, ${id}, ${item.item_id}, ${item.quantity}, ${item.rate}, ${item.tax_amount || 0}, ${item.total || item.amount || ((item.quantity || 0) * (item.rate || 0)) || 0})`;

        await updateStock(item.item_id, item.quantity, 'out', id, 'Purchase Return', Number(item.rate || 0));
      }
    }
    const docResult = await db.query`SELECT * FROM purchase_returns WHERE id = ${id}`;
    res.json(docResult.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/purchase-returns/:id", authenticate, async (req, res) => {
  try {
    const { vendor_id, bill_id, date, subtotal, tax_amount, total, reason, notes, status, items } = req.body;
    await db.query`UPDATE purchase_returns SET vendor_id = COALESCE(${vendor_id}, vendor_id), bill_id = COALESCE(${bill_id}, bill_id), date = COALESCE(${date}, date), subtotal = COALESCE(${subtotal}, subtotal), tax_amount = COALESCE(${tax_amount}, tax_amount), total = COALESCE(${total}, total), reason = COALESCE(${reason}, reason), notes = COALESCE(${notes}, notes), status = COALESCE(${status}, status), updated_at = GETDATE() WHERE id = ${req.params.id}`;

    if (items && Array.isArray(items)) {
      await db.query`DELETE FROM purchase_return_items WHERE purchase_return_id = ${req.params.id}`;
      for (const item of items) {
        await db.query`INSERT INTO purchase_return_items (id, purchase_return_id, item_id, quantity, rate, tax_amount, total) 
          VALUES (${uuidv4()}, ${req.params.id}, ${item.item_id}, ${item.quantity}, ${item.rate}, ${item.tax_amount || 0}, ${item.total || item.amount || ((item.quantity || 0) * (item.rate || 0)) || 0})`;
      }
    }
    const docResult = await db.query`SELECT * FROM purchase_returns WHERE id = ${req.params.id}`;
    res.json(docResult.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/purchase-returns/:id", authenticate, async (req, res) => {
  try {
    await db.query`DELETE FROM purchase_return_items WHERE purchase_return_id = ${req.params.id}`;
    await db.query`DELETE FROM purchase_returns WHERE id = ${req.params.id}`;
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ===== GST RETURNS =====
router.get("/gst-returns", authenticate, async (req, res) => {
  try {
    const data = await db.query`SELECT * FROM gst_returns ORDER BY created_at DESC`.then(res => res.recordset);
    res.json(data);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ===== WORKFLOWS =====
router.get("/workflows", authenticate, async (req, res) => {
  try {
    const data = await db.query`SELECT * FROM workflows ORDER BY created_at DESC`.then(res => res.recordset);
    res.json(data);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/workflows", authenticate, async (req: AuthRequest, res) => {
  try {
    const id = uuidv4();
    const { name, trigger, conditions, actions, status } = req.body;
    await db.query`INSERT INTO workflows (id, name, [trigger], [conditions], [actions], status, created_at, updated_at) 
      VALUES (${id}, ${name}, ${trigger}, ${JSON.stringify(conditions || [])}, ${JSON.stringify(actions || [])}, ${status || 'active'}, GETDATE(), GETDATE())`;
    const docResult = await db.query`SELECT * FROM workflows WHERE id = ${id}`;
    res.json(docResult.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/workflows/:id", authenticate, async (req, res) => {
  try {
    const { name, trigger, conditions, actions, status } = req.body;
    await db.query`
      UPDATE workflows
      SET name = COALESCE(${name}, name),
          [trigger] = COALESCE(${trigger}, [trigger]),
          [conditions] = COALESCE(${conditions ? JSON.stringify(conditions) : null}, [conditions]),
          [actions] = COALESCE(${actions ? JSON.stringify(actions) : null}, [actions]),
          status = COALESCE(${status}, status),
          updated_at = GETDATE()
      WHERE id = ${req.params.id}
    `;
    const dataResult = await db.query`SELECT * FROM workflows WHERE id = ${req.params.id}`;
    res.json(dataResult.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/workflows/:id", authenticate, async (req, res) => {
  try {
    await db.query`DELETE FROM workflows WHERE id = ${req.params.id}`;
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ===== BANK ACCOUNTS =====
router.get("/bank-accounts", authenticate, async (req, res) => {
  try {
    const data = await db.query`SELECT * FROM bank_accounts ORDER BY bank_name`.then(res => res.recordset);
    res.json(data);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/bank-accounts", authenticate, async (req, res) => {
  try {
    const id = uuidv4();
    const { bank_name, account_number, ifsc_code, branch_name, current_balance, account_id } = req.body;
    await db.query`INSERT INTO bank_accounts (id, bank_name, account_number, ifsc_code, branch_name, current_balance, account_id, created_at, updated_at) 
      VALUES (${id}, ${bank_name}, ${account_number}, ${ifsc_code}, ${branch_name}, ${current_balance || 0}, ${account_id || null}, GETDATE(), GETDATE())`;
    const dataResult = await db.query`SELECT * FROM bank_accounts WHERE id = ${id}`;
    res.json(dataResult.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});


// ===== EXPENSES =====
router.get("/expenses", authenticate, async (req, res) => {
  try {
    await sendPaginatedResults(req, res, `
      SELECT e.*, v.name as vendor_name, a.name as account_name 
      FROM expenses e 
      LEFT JOIN vendors v ON e.vendor_id = v.id 
      LEFT JOIN accounts a ON e.account_id = a.id
      ORDER BY e.date DESC
    `, `SELECT COUNT(*) as total FROM expenses`);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/expenses", authenticate, async (req: AuthRequest, res) => {
  try {
    const id = uuidv4();
    const { date, category, vendor_id, account_id, amount, tax_amount, payment_mode, description, is_recurring, recurring_frequency } = req.body;
    const expenseDate = date || new Date().toISOString().split("T")[0];
    await db.query`INSERT INTO expenses (id, date, category, vendor_id, account_id, amount, tax_amount, payment_mode, description, is_recurring, recurring_frequency, created_by, created_at, updated_at) 
      VALUES (${id}, ${expenseDate}, ${category}, ${vendor_id || null}, ${account_id || null}, ${amount}, ${tax_amount || 0}, ${payment_mode || 'cash'}, ${description || null}, ${is_recurring ?? 0}, ${recurring_frequency || null}, ${req.user!.id}, GETDATE(), GETDATE())`;
    const dataResult = await db.query`SELECT * FROM expenses WHERE id = ${id}`;
    res.json(dataResult.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/expenses/:id", authenticate, async (req, res) => {
  try {
    await db.query`DELETE FROM expenses WHERE id = ${req.params.id}`;
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ===== PAYMENTS RECEIVED =====
router.get("/payments-received", authenticate, async (req, res) => {
  try {
    await sendPaginatedResults(req, res, `
      SELECT pr.*, c.name as customer_name, i.document_number as invoice_number, i.balance_due as invoice_balance_due, i.total as invoice_total
      FROM payments_received pr
      LEFT JOIN customers c ON pr.customer_id = c.id
      LEFT JOIN invoices i ON pr.invoice_id = i.id
      ORDER BY pr.date DESC
    `, `SELECT COUNT(*) as total FROM payments_received`);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/payments-received/:id", authenticate, async (req, res) => {
  try {
    const dataResult = await db.query`
      SELECT pr.*, c.name as customer_name, c.gstin as customer_gstin, c.billing_address as customer_address, c.state as customer_state, i.document_number as invoice_number
      FROM payments_received pr
      LEFT JOIN customers c ON pr.customer_id = c.id
      LEFT JOIN invoices i ON pr.invoice_id = i.id
      WHERE pr.id = ${req.params.id}
    `;
    const data = dataResult.recordset[0];
    if (!data) { res.status(404).json({ error: "Not found" }); return; }

    let invoice = null;
    if (data.invoice_id) {
      const invoiceResult = await db.query`
        SELECT i.*, c.name as customer_name, c.gstin as customer_gstin, c.billing_address as customer_address, c.state as customer_state
        FROM invoices i
        LEFT JOIN customers c ON i.customer_id = c.id
        WHERE i.id = ${data.invoice_id}
      `;
      const invoiceData = invoiceResult.recordset[0];
      if (invoiceData) {
        const invoiceItems = await db.query`
          SELECT ii.*, it.name as item_name, it.hsn_code
          FROM invoice_items ii
          LEFT JOIN items it ON ii.item_id = it.id
          WHERE ii.invoice_id = ${data.invoice_id}
          ORDER BY ii.sort_order
        `.then(res => res.recordset);
        invoice = { ...invoiceData, items: invoiceItems };
      }
    }

    res.json({ ...data, invoice });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});
router.post("/payments-received", authenticate, async (req: AuthRequest, res) => {
  try {
    const id = uuidv4();
    const { customer_id, invoice_id, amount, date, payment_mode, reference_number, notes } = req.body;
    const payment_number = await generateDocNumber('payment_received');

    await db.query`INSERT INTO payments_received (id, payment_number, date, customer_id, invoice_id, amount, payment_mode, reference_number, notes, created_by, created_at) 
      VALUES (${id}, ${payment_number}, ${date}, ${customer_id}, ${invoice_id || null}, ${amount}, ${payment_mode || 'cash'}, ${reference_number || null}, ${notes || null}, ${req.user!.id}, GETDATE())`;

    if (invoice_id) {
      const invResult = await db.query`SELECT balance_due FROM invoices WHERE id = ${invoice_id}`;
      const inv = invResult.recordset[0];
      if (inv) {
        const newBalance = Math.max(0, Number(inv.balance_due) - Number(amount));
        const newStatus = newBalance <= 0 ? 'paid' : 'partial';
        await db.query`UPDATE invoices SET balance_due = ${newBalance}, status = ${newStatus}, updated_at = GETDATE() WHERE id = ${invoice_id}`;
      }
    }

    const dataResult = await db.query`SELECT * FROM payments_received WHERE id = ${id}`;
    res.json(dataResult.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/payments-received/:id", authenticate, async (req, res) => {
  try {
    await db.query`DELETE FROM payments_received WHERE id = ${req.params.id}`;
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ===== PAYMENTS MADE =====
router.get("/payments-made", authenticate, async (req, res) => {
  try {
    await sendPaginatedResults(req, res, `
      SELECT pm.*, v.name as vendor_name, b.document_number as bill_number, b.balance_due as bill_balance_due, b.total as bill_total
      FROM payments_made pm
      LEFT JOIN vendors v ON pm.vendor_id = v.id
      LEFT JOIN bills b ON pm.bill_id = b.id
      ORDER BY pm.date DESC
    `, `SELECT COUNT(*) as total FROM payments_made`);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/payments-made/:id", authenticate, async (req, res) => {
  try {
    const dataResult = await db.query`
      SELECT pm.*, v.name as vendor_name, v.gstin as vendor_gstin, v.address as vendor_address, v.state as vendor_state, b.document_number as bill_number
      FROM payments_made pm
      LEFT JOIN vendors v ON pm.vendor_id = v.id
      LEFT JOIN bills b ON pm.bill_id = b.id
      WHERE pm.id = ${req.params.id}
    `;
    const data = dataResult.recordset[0];
    if (!data) { res.status(404).json({ error: "Not found" }); return; }

    let bill = null;
    if (data.bill_id) {
      const billResult = await db.query`
        SELECT b.*, v.name as vendor_name, v.gstin as vendor_gstin, v.address as vendor_address, v.state as vendor_state
        FROM bills b
        LEFT JOIN vendors v ON b.vendor_id = v.id
        WHERE b.id = ${data.bill_id}
      `;
      const billData = billResult.recordset[0];
      if (billData) {
        const billItems = await db.query`
          SELECT bi.*, i.name as item_name, i.hsn_code
          FROM bill_items bi
          LEFT JOIN items i ON bi.item_id = i.id
          WHERE bi.bill_id = ${data.bill_id}
          ORDER BY bi.sort_order
        `.then(res => res.recordset);
        bill = { ...billData, items: billItems };
      }
    }

    res.json({ ...data, bill });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});
router.post("/payments-made", authenticate, async (req: AuthRequest, res) => {
  try {
    const id = uuidv4();
    const { vendor_id, bill_id, amount, date, payment_mode, reference_number, notes } = req.body;
    const payment_number = await generateDocNumber('payment_made');

    await db.query`INSERT INTO payments_made (id, payment_number, date, vendor_id, bill_id, amount, payment_mode, reference_number, notes, created_by, created_at) 
      VALUES (${id}, ${payment_number}, ${date}, ${vendor_id}, ${bill_id || null}, ${amount}, ${payment_mode || 'bank_transfer'}, ${reference_number || null}, ${notes || null}, ${req.user!.id}, GETDATE())`;

    if (bill_id) {
      const billResult = await db.query`SELECT balance_due FROM bills WHERE id = ${bill_id}`;
      const bill = billResult.recordset[0];
      if (bill) {
        const newBalance = Math.max(0, Number(bill.balance_due) - Number(amount));
        const newStatus = newBalance <= 0 ? 'paid' : 'partial';
        await db.query`UPDATE bills SET balance_due = ${newBalance}, status = ${newStatus}, updated_at = GETDATE() WHERE id = ${bill_id}`;
      }
    }

    const dataResult = await db.query`SELECT * FROM payments_made WHERE id = ${id}`;
    res.json(dataResult.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/payments-made/:id", authenticate, async (req, res) => {
  try {
    await db.query`DELETE FROM payments_made WHERE id = ${req.params.id}`;
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ===== DASHBOARD =====
router.get("/dashboard/stats", authenticate, async (req, res) => {
  try {
    const custCountResult = await db.query`SELECT COUNT(*) as count FROM customers`;
    const invCountResult = await db.query`SELECT COUNT(*) as count FROM invoices`;
    const allInvoicesResult = await db.query`SELECT total, balance_due, status, tax_amount FROM invoices`;
    const allBillsResult = await db.query`SELECT total, balance_due, status, tax_amount FROM bills`;
    const allItemsResult = await db.query`SELECT current_stock, selling_rate, reorder_level FROM items`;
    const allExpensesResult = await db.query`SELECT tax_amount FROM expenses`;

    const allInvoices = allInvoicesResult.recordset;
    const allBills = allBillsResult.recordset;
    const allItems = allItemsResult.recordset;
    const allExpenses = allExpensesResult.recordset;

    const totalSales = allInvoices.reduce((s: number, i: any) => s + Number(i.total), 0);
    const totalReceivables = allInvoices.reduce((s: number, i: any) => s + Number(i.balance_due), 0);
    const totalPurchase = allBills.reduce((s: number, b: any) => s + Number(b.total), 0);
    const totalPayables = allBills.reduce((s: number, b: any) => s + Number(b.balance_due), 0);
    const stockValue = allItems.reduce((s: number, i: any) => s + Number(i.current_stock) * Number(i.selling_rate), 0);
    const lowStockCount = allItems.filter((i: any) => Number(i.current_stock) <= Number(i.reorder_level)).length;
    const outputGst = allInvoices.reduce((s: number, i: any) => s + Number(i.tax_amount), 0);
    const inputGstFromBills = allBills.reduce((s: number, b: any) => s + Number(b.tax_amount), 0);
    const inputGstFromExpenses = allExpenses.reduce((s: number, e: any) => s + Number(e.tax_amount), 0);
    const gstPayable = outputGst - inputGstFromBills - inputGstFromExpenses;

    res.json({
      totalSales, totalPurchase, totalReceivables, totalPayables,
      stockValue, lowStockCount, gstPayable,
      customerCount: Number(custCountResult.recordset[0]?.count || 0),
      invoiceCount: Number(invCountResult.recordset[0]?.count || 0),
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/dashboard/recent-invoices", authenticate, async (req, res) => {
  try {
    const shouldPaginate = req.query.page !== undefined || req.query.limit !== undefined;
    const parsedPage = Number.parseInt(String(req.query.page ?? "1"), 10);
    const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
    const limit = 10;
    const offset = (page - 1) * limit;

    if (!shouldPaginate) {
      const dataResult = await db.query`
        SELECT i.*, c.name as customer_name
        FROM invoices i
        LEFT JOIN customers c ON i.customer_id = c.id
        ORDER BY i.created_at DESC
      `;
      const data = dataResult.recordset.map(row => ({
        ...row,
        customers: { name: row.customer_name }
      }));
      res.json(data);
      return;
    }

    const [dataResult, countResult] = await Promise.all([
      runRawQuery(`
        SELECT i.*, c.name as customer_name
        FROM invoices i
        LEFT JOIN customers c ON i.customer_id = c.id
        ORDER BY i.created_at DESC
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
      `, { offset, limit }),
      runRawQuery(`SELECT COUNT(*) as total FROM invoices`),
    ]);

    const total = Number(countResult.recordset[0]?.total || 0);
    const data = dataResult.recordset.map(row => ({
      ...row,
      customers: { name: row.customer_name }
    }));

    res.json({
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: total === 0 ? 0 : Math.ceil(total / limit),
        start: total === 0 ? 0 : offset + 1,
        end: total === 0 ? 0 : Math.min(offset + data.length, total),
      },
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/dashboard/low-stock", authenticate, async (req, res) => {
  try {
    const shouldPaginate = req.query.page !== undefined || req.query.limit !== undefined;
    const parsedPage = Number.parseInt(String(req.query.page ?? "1"), 10);
    const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
    const limit = 5;
    const offset = (page - 1) * limit;

    const countResult = await runRawQuery(`
      SELECT COUNT(*) as total
      FROM items
      WHERE COALESCE(current_stock, 0) <= COALESCE(reorder_level, 0)
    `);
    const total = Number(countResult.recordset[0]?.total || 0);

    if (!shouldPaginate) {
      const dataResult = await runRawQuery(`
        SELECT *
        FROM items
        WHERE COALESCE(current_stock, 0) <= COALESCE(reorder_level, 0)
        ORDER BY current_stock ASC, created_at DESC
      `);
      res.json(dataResult.recordset);
      return;
    }

    const dataResult = await runRawQuery(`
      SELECT *
      FROM items
      WHERE COALESCE(current_stock, 0) <= COALESCE(reorder_level, 0)
      ORDER BY current_stock ASC, created_at DESC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `, { offset, limit });

    res.json({
      data: dataResult.recordset,
      pagination: {
        page,
        limit,
        total,
        totalPages: total === 0 ? 0 : Math.ceil(total / limit),
        start: total === 0 ? 0 : offset + 1,
        end: total === 0 ? 0 : Math.min(offset + dataResult.recordset.length, total),
      },
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/invoice-items", authenticate, async (req, res) => {
  try {
    const dataResult = await db.query`
      SELECT TOP 500
        ii.*,
        inv.document_number,
        inv.date as invoice_date,
        inv.status as invoice_status,
        it.name as item_name,
        it.hsn_code
      FROM invoice_items ii
      INNER JOIN invoices inv ON ii.invoice_id = inv.id
      LEFT JOIN items it ON ii.item_id = it.id
      ORDER BY inv.date DESC, ii.sort_order ASC
    `;
    res.json(dataResult.recordset);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/gst/hsn-summary", authenticate, async (req, res) => {
  try {
    const dataResult = await db.query`
      SELECT
        summary.hsn,
        (
          SELECT STRING_AGG(names.item_name, ', ')
          FROM (
            SELECT DISTINCT
              COALESCE(
                NULLIF(LTRIM(RTRIM(it2.name)), ''),
                NULLIF(LTRIM(RTRIM(ii2.description)), ''),
                'Unknown Item'
              ) as item_name
            FROM invoice_items ii2
            INNER JOIN invoices inv2 ON ii2.invoice_id = inv2.id
            LEFT JOIN items it2 ON ii2.item_id = it2.id
            WHERE COALESCE(inv2.status, '') <> 'draft'
              AND COALESCE(NULLIF(LTRIM(RTRIM(it2.hsn_code)), ''), 'N/A') = summary.hsn
          ) names
        ) as item_names,
        summary.qty,
        summary.taxable_value,
        summary.tax_value,
        summary.total_value,
        summary.invoice_count
      FROM (
        SELECT
          COALESCE(NULLIF(LTRIM(RTRIM(it.hsn_code)), ''), 'N/A') as hsn,
          SUM(COALESCE(ii.quantity, 0)) as qty,
          SUM(COALESCE(ii.amount, 0)) as taxable_value,
          SUM(COALESCE(ii.tax_amount, 0)) as tax_value,
          SUM(COALESCE(ii.amount, 0) + COALESCE(ii.tax_amount, 0)) as total_value,
          COUNT(DISTINCT ii.invoice_id) as invoice_count
        FROM invoice_items ii
        INNER JOIN invoices inv ON ii.invoice_id = inv.id
        LEFT JOIN items it ON ii.item_id = it.id
        WHERE COALESCE(inv.status, '') <> 'draft'
        GROUP BY COALESCE(NULLIF(LTRIM(RTRIM(it.hsn_code)), ''), 'N/A')
      ) summary
      ORDER BY summary.total_value DESC, summary.hsn ASC
    `;
    sendPaginatedArray(req, res, dataResult.recordset);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ===== DELIVERY CHALLANS =====
router.get("/delivery-challans", authenticate, async (req, res) => {
  try {
    await sendPaginatedResults(req, res, `
      SELECT dc.*, c.name as customer_name
      FROM delivery_challans dc
      LEFT JOIN customers c ON dc.customer_id = c.id
      ORDER BY dc.created_at DESC
    `, `SELECT COUNT(*) as total FROM delivery_challans`);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/delivery-challans/:id", authenticate, async (req, res) => {
  try {
    const dataResult = await db.query`
      SELECT dc.*, c.name as customer_name, c.gstin as customer_gstin, c.billing_address as customer_address, c.state as customer_state
      FROM delivery_challans dc 
      LEFT JOIN customers c ON dc.customer_id = c.id
      WHERE dc.id = ${req.params.id}
    `;
    const data = dataResult.recordset[0];
    if (!data) { res.status(404).json({ error: "Not found" }); return; }

    const items = await db.query`
      SELECT
        dci.id,
        dci.delivery_challan_id,
        dci.item_id,
        dci.description,
        dci.quantity,
        dci.sort_order,
        i.name as item_name,
        i.hsn_code,
        CASE
          WHEN COALESCE(dci.rate, 0) = 0 AND COALESCE(dci.amount, 0) = 0 AND COALESCE(dci.tax_amount, 0) = 0
            THEN COALESCE(soi.rate, i.selling_rate, 0)
          ELSE COALESCE(dci.rate, 0)
        END as rate,
        CASE
          WHEN COALESCE(dci.rate, 0) = 0 AND COALESCE(dci.amount, 0) = 0 AND COALESCE(dci.tax_amount, 0) = 0
            THEN CAST(dci.quantity * COALESCE(soi.rate, i.selling_rate, 0) AS DECIMAL(18, 2))
          ELSE COALESCE(dci.amount, 0)
        END as amount,
        CASE
          WHEN COALESCE(dci.rate, 0) = 0 AND COALESCE(dci.amount, 0) = 0 AND COALESCE(dci.tax_amount, 0) = 0
            THEN CAST(
              dci.quantity * COALESCE(COALESCE(soi.tax_amount, 0) / NULLIF(soi.quantity, 0), 0)
              AS DECIMAL(18, 2)
            )
          ELSE COALESCE(dci.tax_amount, 0)
        END as tax_amount,
        COALESCE(dci.tax_rate_id, soi.tax_rate_id, i.tax_rate_id) as tax_rate_id,
        COALESCE(tr.rate, 0) as tax_rate
      FROM delivery_challan_items dci
      LEFT JOIN delivery_challans dc ON dci.delivery_challan_id = dc.id
      LEFT JOIN items i ON dci.item_id = i.id
      LEFT JOIN sales_order_items soi ON soi.sales_order_id = dc.sales_order_id AND soi.item_id = dci.item_id AND soi.sort_order = dci.sort_order
      LEFT JOIN tax_rates tr ON tr.id = COALESCE(dci.tax_rate_id, soi.tax_rate_id, i.tax_rate_id)
      WHERE dci.delivery_challan_id = ${req.params.id}
      ORDER BY dci.sort_order
    `.then(res => res.recordset);

    const computedSubtotal = items.reduce((sum: number, item: any) => sum + Number(item.amount || 0), 0);
    const computedTaxAmount = items.reduce((sum: number, item: any) => sum + Number(item.tax_amount || 0), 0);
    const computedTotal = computedSubtotal + computedTaxAmount;

    const subtotal = Number(data.subtotal || 0) > 0 ? Number(data.subtotal) : computedSubtotal;
    const taxAmount = Number(data.tax_amount || 0) > 0 ? Number(data.tax_amount) : computedTaxAmount;
    const total = Number(data.total || 0) > 0 ? Number(data.total) : computedTotal;

    res.json({
      ...data,
      subtotal,
      tax_amount: taxAmount,
      total,
      items,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/delivery-challans", authenticate, async (req: AuthRequest, res) => {
  try {
    const id = uuidv4();
    const { customer_id, date, sales_order_id, reference_id, reference_type, status, notes, subtotal, tax_amount, total, items } = req.body;
    const document_number = await generateDocNumber('delivery_challan');
    const safeItems = Array.isArray(items) ? items : [];
    const computedSubtotal = subtotal ?? safeItems.reduce((sum: number, item: any) => sum + Number(item.amount || (Number(item.quantity || 0) * Number(item.rate || 0))), 0);
    const computedTaxAmount = tax_amount ?? safeItems.reduce((sum: number, item: any) => sum + Number(item.tax_amount || 0), 0);
    const computedTotal = total ?? (Number(computedSubtotal) + Number(computedTaxAmount));

    await db.query`INSERT INTO delivery_challans (id, document_number, date, customer_id, sales_order_id, reference_id, reference_type, status, notes, subtotal, tax_amount, total, created_by, created_at, updated_at) 
      VALUES (${id}, ${document_number}, ${date}, ${customer_id}, ${sales_order_id || null}, ${reference_id || null}, ${reference_type || null}, ${status || 'draft'}, ${notes || null}, ${computedSubtotal}, ${computedTaxAmount}, ${computedTotal}, ${req.user!.id}, GETDATE(), GETDATE())`;

    for (let i = 0; i < safeItems.length; i++) {
      const item = safeItems[i];
      const lineAmount = Number(item.amount || (Number(item.quantity || 0) * Number(item.rate || 0)));
      await db.query`INSERT INTO delivery_challan_items (id, delivery_challan_id, item_id, description, quantity, rate, tax_rate_id, tax_amount, amount, sort_order) 
        VALUES (${uuidv4()}, ${id}, ${item.item_id}, ${item.description || null}, ${item.quantity || 1}, ${item.rate || 0}, ${item.tax_rate_id || null}, ${item.tax_amount || 0}, ${lineAmount}, ${i})`;
    }

    const dataResult = await db.query`SELECT * FROM delivery_challans WHERE id = ${id}`;
    res.json(dataResult.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/delivery-challans/:id", authenticate, async (req, res) => {
  try {
    const { customer_id, date, sales_order_id, reference_id, reference_type, status, notes, subtotal, tax_amount, total, items } = req.body;
    const safeItems = Array.isArray(items) ? items : [];
    const computedSubtotal = subtotal ?? safeItems.reduce((sum: number, item: any) => sum + Number(item.amount || (Number(item.quantity || 0) * Number(item.rate || 0))), 0);
    const computedTaxAmount = tax_amount ?? safeItems.reduce((sum: number, item: any) => sum + Number(item.tax_amount || 0), 0);
    const computedTotal = total ?? (Number(computedSubtotal) + Number(computedTaxAmount));

    await db.query`UPDATE delivery_challans SET customer_id = COALESCE(${customer_id}, customer_id), date = COALESCE(${date}, date), sales_order_id = COALESCE(${sales_order_id}, sales_order_id), reference_id = COALESCE(${reference_id}, reference_id), reference_type = COALESCE(${reference_type}, reference_type), status = COALESCE(${status}, status), notes = COALESCE(${notes}, notes), subtotal = COALESCE(${computedSubtotal}, subtotal), tax_amount = COALESCE(${computedTaxAmount}, tax_amount), total = COALESCE(${computedTotal}, total), updated_at = GETDATE() WHERE id = ${req.params.id}`;

    if (Array.isArray(items)) {
      await db.query`DELETE FROM delivery_challan_items WHERE delivery_challan_id = ${req.params.id}`;
      for (let i = 0; i < safeItems.length; i++) {
        const item = safeItems[i];
        const lineAmount = Number(item.amount || (Number(item.quantity || 0) * Number(item.rate || 0)));
        await db.query`INSERT INTO delivery_challan_items (id, delivery_challan_id, item_id, description, quantity, rate, tax_rate_id, tax_amount, amount, sort_order) 
          VALUES (${uuidv4()}, ${req.params.id}, ${item.item_id}, ${item.description || null}, ${item.quantity || 1}, ${item.rate || 0}, ${item.tax_rate_id || null}, ${item.tax_amount || 0}, ${lineAmount}, ${i})`;
      }
    }
    const dataResult = await db.query`SELECT * FROM delivery_challans WHERE id = ${req.params.id}`;
    res.json(dataResult.recordset[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.patch("/delivery-challans/:id/status", authenticate, async (req, res) => {
  try {
    const { status } = req.body;
    await db.query`UPDATE delivery_challans SET status = ${status}, updated_at = GETDATE() WHERE id = ${req.params.id}`;
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/delivery-challans/:id", authenticate, async (req, res) => {
  try {
    await db.query`DELETE FROM delivery_challan_items WHERE delivery_challan_id = ${req.params.id}`;
    await db.query`DELETE FROM delivery_challans WHERE id = ${req.params.id}`;
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;

























































