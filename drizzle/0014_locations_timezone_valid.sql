-- F-7-5 part 1: locations.timezone must be an IANA zone both Postgres and Intl accept. A CHECK can't query
-- pg_timezone_names, so a trigger enforces it on insert and on any change of the zone. Existing rows are not
-- re-checked (a bad one already fails safe: its rows error and send nothing). The three names excluded are
-- listed by Postgres but rejected by Intl.
CREATE FUNCTION "locations_timezone_valid"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.timezone IN ('localtime', 'posixrules', 'Factory')
		OR NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone) THEN
		RAISE EXCEPTION 'locations.timezone is not a valid IANA time zone'
			USING ERRCODE = 'check_violation', CONSTRAINT = 'locations_timezone_valid';
	END IF;
	RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "locations_timezone_valid" BEFORE INSERT OR UPDATE OF "timezone" ON "locations"
	FOR EACH ROW EXECUTE FUNCTION "locations_timezone_valid"();