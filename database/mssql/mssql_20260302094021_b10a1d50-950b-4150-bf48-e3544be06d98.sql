-- SQL Server converted migration (auto-converted from Supabase/PostgreSQL).
-- Removed PostgreSQL-only constructs: RLS policies, plpgsql functions, Supabase auth hooks.
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

-- Fix overly permissive audit trail INSERT policy
-- Note: RLS policies are not applicable in SQL Server

-- Seed document sequences
INSERT INTO dbo.document_sequences (document_type, prefix, next_number, padding) 
SELECT * FROM (VALUES
    ('quotation', 'QT-', 1, 4),
    ('sales_order', 'SO-', 1, 4),
    ('delivery_challan', 'DC-', 1, 4),
    ('invoice', 'INV-', 1, 4),
    ('credit_note', 'CN-', 1, 4),
    ('purchase_order', 'PO-', 1, 4),
    ('bill', 'BILL-', 1, 4),
    ('vendor_credit', 'VC-', 1, 4),
    ('sales_return', 'SR-', 1, 4),
    ('purchase_return', 'PRTN-', 1, 4),
    ('payment_received', 'PR-', 1, 4),
    ('payment_made', 'PM-', 1, 4),
    ('journal_entry', 'JE-', 1, 4),
    ('expense', 'EXP-', 1, 4)
) AS data(document_type, prefix, next_number, padding)
WHERE NOT EXISTS (
    SELECT 1 FROM dbo.document_sequences 
    WHERE document_type = data.document_type
);
GO

-- Seed default chart of accounts
INSERT INTO dbo.accounts (code, name, account_type, is_system) 
SELECT * FROM (VALUES
    ('1000', 'Cash', 'asset', 1),
    ('1010', 'Bank - Current Account', 'asset', 1),
    ('1100', 'Accounts Receivable', 'asset', 1),
    ('1200', 'Inventory', 'asset', 1),
    ('1300', 'Input Tax Credit (GST)', 'asset', 1),
    ('2000', 'Accounts Payable', 'liability', 1),
    ('2100', 'GST Payable - CGST', 'liability', 1),
    ('2110', 'GST Payable - SGST', 'liability', 1),
    ('2120', 'GST Payable - IGST', 'liability', 1),
    ('2200', 'TDS Payable', 'liability', 1),
    ('3000', 'Capital Account', 'equity', 1),
    ('3100', 'Retained Earnings', 'equity', 1),
    ('4000', 'Sales Revenue', 'income', 1),
    ('4100', 'Other Income', 'income', 1),
    ('4200', 'Discount Received', 'income', 1),
    ('5000', 'Cost of Goods Sold', 'expense', 1),
    ('5100', 'Operating Expenses', 'expense', 1),
    ('5200', 'Rent Expense', 'expense', 1),
    ('5300', 'Salary Expense', 'expense', 1),
    ('5400', 'Utility Expense', 'expense', 1),
    ('5500', 'Depreciation', 'expense', 1),
    ('5600', 'Purchase Discount', 'expense', 1)
) AS data(code, name, account_type, is_system)
WHERE NOT EXISTS (
    SELECT 1 FROM dbo.accounts 
    WHERE code = data.code
);
GO

-- Seed default tax rates
INSERT INTO dbo.tax_rates (name, rate, tax_type) 
SELECT * FROM (VALUES
    ('CGST 2.5%', 2.50, 'cgst'),
    ('SGST 2.5%', 2.50, 'sgst'),
    ('CGST 6%', 6.00, 'cgst'),
    ('SGST 6%', 6.00, 'sgst'),
    ('CGST 9%', 9.00, 'cgst'),
    ('SGST 9%', 9.00, 'sgst'),
    ('CGST 14%', 14.00, 'cgst'),
    ('SGST 14%', 14.00, 'sgst'),
    ('IGST 5%', 5.00, 'igst'),
    ('IGST 12%', 12.00, 'igst'),
    ('IGST 18%', 18.00, 'igst'),
    ('IGST 28%', 28.00, 'igst')
) AS data(name, rate, tax_type)
WHERE NOT EXISTS (
    SELECT 1 FROM dbo.tax_rates 
    WHERE name = data.name
);
GO

-- Seed default GST settings
IF NOT EXISTS (SELECT 1 FROM dbo.gst_settings)
BEGIN
    INSERT INTO dbo.gst_settings (gstin, legal_name, trade_name, state, state_code)
    VALUES ('', 'Your Company Name', 'Your Company', 'Maharashtra', '27');
END
ELSE
BEGIN
    UPDATE dbo.gst_settings 
    SET gstin = '',
        legal_name = 'Your Company Name',
        trade_name = 'Your Company',
        state = 'Maharashtra',
        state_code = '27',
        updated_at = GETDATE()
    WHERE id = (SELECT TOP 1 id FROM dbo.gst_settings);
END
GO

-- Note: PostgreSQL's NOTIFY pgrst, 'reload schema' is not applicable in SQL Server
-- In SQL Server, you might want to use:
-- EXEC sp_refreshsqlmodule 'your_procedure_name' for specific objects if needed

PRINT 'Seed data inserted successfully!';
GO

