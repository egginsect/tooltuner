-- Run explicitly as the schema owner; never from application startup.
-- Provision flywheel_credential_runtime separately. No passwords or logins are created here.
-- See docs/credential-rls.md for the trusted-backend boundary and rollout order.
BEGIN;
LOCK TABLE public.flywheel_upstream_credentials IN ACCESS EXCLUSIVE MODE;
DO $checks$
DECLARE runtime_oid oid;
BEGIN
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles
    WHERE rolname = 'flywheel_credential_runtime'
      AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication;
  IF runtime_oid IS NULL THEN
    RAISE EXCEPTION 'Provision a restricted flywheel_credential_runtime role before migration';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = runtime_oid OR roleid = runtime_oid) THEN
    RAISE EXCEPTION 'Runtime role must have no role memberships or member roles';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE oid = 'public.flywheel_upstream_credentials'::regclass AND relowner = runtime_oid) THEN
    RAISE EXCEPTION 'Runtime role must not own the credential table';
  END IF;
  IF has_schema_privilege(runtime_oid, 'public', 'CREATE') OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_database WHERE datname = current_database() AND datdba = runtime_oid
  ) THEN
    RAISE EXCEPTION 'Runtime role must not own the database or have schema CREATE privileges';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid = 'public.flywheel_upstream_credentials'::regclass) THEN
    RAISE EXCEPTION 'Review existing credential policies before migration';
  END IF;
END
$checks$;
ALTER TABLE public.flywheel_upstream_credentials ADD COLUMN IF NOT EXISTS owner_id text;
UPDATE public.flywheel_upstream_credentials SET owner_id = binding::jsonb ->> 'owner_id' WHERE owner_id IS NULL;
ALTER TABLE public.flywheel_upstream_credentials ALTER COLUMN owner_id SET NOT NULL;
-- Replacing this named constraint validates all existing rows, including legacy namespaces.
ALTER TABLE public.flywheel_upstream_credentials DROP CONSTRAINT IF EXISTS credential_binding_owner;
ALTER TABLE public.flywheel_upstream_credentials ADD CONSTRAINT credential_binding_owner CHECK (
  jsonb_typeof(binding::jsonb -> 'owner_id') = 'string'
  AND (binding::jsonb ->> 'owner_id') IS NOT NULL
  AND owner_id = (binding::jsonb ->> 'owner_id') AND length(owner_id) > 0
);
ALTER TABLE public.flywheel_upstream_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flywheel_upstream_credentials FORCE ROW LEVEL SECURITY;
DO $grants$
DECLARE role_name text; column_names text;
BEGIN
  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO column_names
    FROM pg_catalog.pg_attribute WHERE attrelid = 'public.flywheel_upstream_credentials'::regclass
      AND attnum > 0 AND NOT attisdropped;
  REVOKE ALL PRIVILEGES ON TABLE public.flywheel_upstream_credentials FROM PUBLIC;
  EXECUTE format('REVOKE ALL PRIVILEGES (%s) ON TABLE public.flywheel_upstream_credentials FROM PUBLIC', column_names);
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'flywheel_credential_runtime'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.flywheel_upstream_credentials FROM %I', role_name);
      EXECUTE format('REVOKE ALL PRIVILEGES (%s) ON TABLE public.flywheel_upstream_credentials FROM %I', column_names, role_name);
    END IF;
  END LOOP;
END
$grants$;
GRANT USAGE ON SCHEMA public TO flywheel_credential_runtime;
GRANT SELECT, INSERT ON TABLE public.flywheel_upstream_credentials TO flywheel_credential_runtime;
GRANT UPDATE (key_version, nonce, ciphertext, tag, token_version, refreshing)
  ON TABLE public.flywheel_upstream_credentials TO flywheel_credential_runtime;
CREATE POLICY credential_backend_scope ON public.flywheel_upstream_credentials
  FOR ALL TO flywheel_credential_runtime
  USING (owner_id = nullif(current_setting('flywheel.credential_owner', true), '')
         AND binding = nullif(current_setting('flywheel.credential_binding', true), ''))
  WITH CHECK (owner_id = nullif(current_setting('flywheel.credential_owner', true), '')
              AND binding = nullif(current_setting('flywheel.credential_binding', true), ''));
COMMIT;
