-- Retention and erasure routines run with `SET LOCAL app.erasure = 'on'`; outside them these tables remain append-only.
CREATE OR REPLACE FUNCTION forbid_mutation_unless_erasure() RETURNS trigger AS $$
BEGIN
  IF current_setting('app.erasure', true) = 'on' THEN RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; END IF;
  RAISE EXCEPTION '% on % is forbidden: table is append-only', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS proctor_webhook_immutable ON "ProctorWebhookEvent";
CREATE TRIGGER proctor_webhook_immutable BEFORE UPDATE OR DELETE ON "ProctorWebhookEvent" FOR EACH ROW EXECUTE FUNCTION forbid_mutation_unless_erasure();
CREATE OR REPLACE FUNCTION forbid_update_keep_feedback() RETURNS trigger AS $$
BEGIN
  IF current_setting('app.erasure', true) = 'on' THEN RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'DELETE on % is forbidden: table is append-only', TG_TABLE_NAME; END IF;
  IF NEW.content IS DISTINCT FROM OLD.content OR NEW.citations IS DISTINCT FROM OLD.citations OR NEW.retrieved IS DISTINCT FROM OLD.retrieved
     OR NEW.status IS DISTINCT FROM OLD.status OR NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'UPDATE of evidence columns on % is forbidden', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
