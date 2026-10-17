-- oxy:deploy-phase=pre
-- ADR 0043: every change to Clarity's reference inventory
-- (`clarity_image_references`) is owed to Oxy, and is recorded in the SAME
-- transaction as the change, so neither a crash nor a code path that forgets
-- can leave Oxy holding a reference Clarity dropped (or missing one it made).
--
-- And the inventory follows the entities that show the images: a document whose
-- `image_url`, or a job whose `employer_logo_url`, changes or is deleted —
-- including the cascade from a pruned document to its job postings — no longer
-- uses the image it showed. Triggers rather than application code because the
-- cascade runs no application code at all.
CREATE FUNCTION clarity_image_references_outbox() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO clarity_oxy_file_reference_outbox (op, oxy_file_id, entity_type, entity_id)
    VALUES ('add', NEW.oxy_file_id, NEW.entity_type, NEW.entity_id);
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO clarity_oxy_file_reference_outbox (op, oxy_file_id, entity_type, entity_id)
    VALUES ('remove', OLD.oxy_file_id, OLD.entity_type, OLD.entity_id);
    RETURN OLD;
  ELSIF NEW.oxy_file_id IS DISTINCT FROM OLD.oxy_file_id THEN
    INSERT INTO clarity_oxy_file_reference_outbox (op, oxy_file_id, entity_type, entity_id)
    VALUES ('remove', OLD.oxy_file_id, OLD.entity_type, OLD.entity_id),
           ('add', NEW.oxy_file_id, NEW.entity_type, NEW.entity_id);
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER clarity_image_references_outbox_insert
AFTER INSERT ON clarity_image_references
FOR EACH ROW EXECUTE FUNCTION clarity_image_references_outbox();
--> statement-breakpoint
CREATE TRIGGER clarity_image_references_outbox_delete
AFTER DELETE ON clarity_image_references
FOR EACH ROW EXECUTE FUNCTION clarity_image_references_outbox();
--> statement-breakpoint
CREATE TRIGGER clarity_image_references_outbox_file
AFTER UPDATE OF oxy_file_id ON clarity_image_references
FOR EACH ROW EXECUTE FUNCTION clarity_image_references_outbox();
--> statement-breakpoint
CREATE FUNCTION clarity_release_document_image() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.image_url IS DISTINCT FROM OLD.image_url THEN
    DELETE FROM clarity_image_references
    WHERE entity_type = 'search_document' AND entity_id = OLD.id;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER clarity_search_documents_release_image
AFTER UPDATE OF image_url OR DELETE ON clarity_search_documents
FOR EACH ROW EXECUTE FUNCTION clarity_release_document_image();
--> statement-breakpoint
CREATE FUNCTION clarity_release_job_logo() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.employer_logo_url IS DISTINCT FROM OLD.employer_logo_url THEN
    DELETE FROM clarity_image_references
    WHERE entity_type = 'job_posting' AND entity_id = OLD.id;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER clarity_job_postings_release_logo
AFTER UPDATE OF employer_logo_url OR DELETE ON clarity_job_postings
FOR EACH ROW EXECUTE FUNCTION clarity_release_job_logo();
