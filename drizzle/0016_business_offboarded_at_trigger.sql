-- Custom migration: businesses.offboarded_at follows status (SPEC Security, Retention: "everything for a business
-- within 30 days of offboarding"). drizzle-kit does not track triggers, so this lives here.
-- Becoming offboarded stamps the time (an explicit value is kept, for backfills); leaving offboarded clears it.
CREATE FUNCTION businesses_offboarded_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'offboarded' THEN
    IF TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'offboarded' OR NEW.offboarded_at IS NULL THEN
      NEW.offboarded_at := coalesce(NEW.offboarded_at, now());
    END IF;
  ELSE
    NEW.offboarded_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER businesses_offboarded_at BEFORE INSERT OR UPDATE ON businesses
  FOR EACH ROW EXECUTE FUNCTION businesses_offboarded_at();
--> statement-breakpoint
-- Businesses already offboarded start their 30 days now.
UPDATE businesses SET offboarded_at = now() WHERE status = 'offboarded' AND offboarded_at IS NULL;
