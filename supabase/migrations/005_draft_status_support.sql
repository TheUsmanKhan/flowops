-- ============================================================================
-- FlowOps — Form Drafts table (for Unsaved Changes Guard system)
-- ============================================================================
-- A generic table for storing in-progress form data as JSON, so users can
-- save their work as a draft before completing a full product/order creation.
-- This avoids modifying the OrgProduct or Order tables — drafts live here
-- separately and are promoted to real records when the user finalizes.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS form_drafts (
  id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "organizationId"  TEXT NOT NULL REFERENCES "Organization"(id) ON DELETE CASCADE,
  "companyId"       TEXT NOT NULL REFERENCES "Company"(id) ON DELETE CASCADE,
  "createdBy"       TEXT REFERENCES "Employee"(id) ON DELETE SET NULL,

  -- Which form this draft belongs to ('product' or 'order')
  "draftType"       TEXT NOT NULL CHECK ("draftType" IN ('product', 'order')),

  -- The actual form data as JSON — shape depends on draftType
  "draftData"       JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Optional title for display in a "recent drafts" list
  "draftTitle"      TEXT,

  "createdAt"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS form_drafts_company_type_idx
  ON form_drafts ("companyId", "draftType", "updatedAt" DESC);

CREATE INDEX IF NOT EXISTS form_drafts_created_by_idx
  ON form_drafts ("createdBy");

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_form_drafts_updatedAt()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW."updatedAt" := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_form_drafts_updatedAt ON form_drafts;
CREATE TRIGGER trg_form_drafts_updatedAt
  BEFORE UPDATE ON form_drafts
  FOR EACH ROW
  EXECUTE FUNCTION update_form_drafts_updatedAt();

-- RLS
ALTER TABLE form_drafts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS form_drafts_select ON form_drafts;
CREATE POLICY form_drafts_select ON form_drafts
  FOR SELECT
  USING ("companyId" = get_active_company_id());

DROP POLICY IF EXISTS form_drafts_insert ON form_drafts;
CREATE POLICY form_drafts_insert ON form_drafts
  FOR INSERT
  WITH CHECK (
    "companyId" = get_active_company_id()
    AND is_elevated_employee(get_active_company_id()) IS TRUE
  );

DROP POLICY IF EXISTS form_drafts_update ON form_drafts;
CREATE POLICY form_drafts_update ON form_drafts
  FOR UPDATE
  USING (
    "companyId" = get_active_company_id()
    AND is_elevated_employee(get_active_company_id()) IS TRUE
  )
  WITH CHECK (
    "companyId" = get_active_company_id()
    AND is_elevated_employee(get_active_company_id()) IS TRUE
  );

DROP POLICY IF EXISTS form_drafts_delete ON form_drafts;
CREATE POLICY form_drafts_delete ON form_drafts
  FOR DELETE
  USING ("companyId" = get_active_company_id());

COMMIT;
