-- Ratings that actually reach the rider.
--
-- A student's review used to sit in `reviews` and nothing else read it: the
-- rider's `kekes.rating` (shown on their home screen and to students picking
-- a keke) stayed at its DEFAULT 5.0 forever. This trigger recomputes it from
-- the reviews of that rider's completed rides whenever a review changes.
--
-- rating_count rides alongside it so the student UI can tell "4.8 from 12
-- reviews" apart from a brand-new rider who has never been rated — a bare
-- 5.0 with no reviews would be a number the app invented.

ALTER TABLE public.kekes ADD COLUMN IF NOT EXISTS rating_count integer NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.sync_keke_rating()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_keke uuid;
  v_avg numeric;
  v_count integer;
BEGIN
  -- The reviewed ride's rider, from whichever row(s) changed.
  SELECT r.keke_id
  INTO v_keke
  FROM public.rides r
  WHERE r.id = COALESCE(NEW.ride_id, OLD.ride_id);

  IF v_keke IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT ROUND(AVG(rv.rating)::numeric, 1), COUNT(*)
  INTO v_avg, v_count
  FROM public.reviews rv
  JOIN public.rides r ON r.id = rv.ride_id
  WHERE r.keke_id = v_keke;

  -- v_count = 0 means the last review for this rider was deleted; keep the
  -- stored average rather than writing NULL into a NOT NULL column.
  IF v_count > 0 THEN
    UPDATE public.kekes k
    SET rating = v_avg,
        rating_count = v_count
    WHERE k.id = v_keke;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$function$;

DROP TRIGGER IF EXISTS reviews_sync_keke_rating ON public.reviews;
CREATE TRIGGER reviews_sync_keke_rating
  AFTER INSERT OR UPDATE OR DELETE ON public.reviews
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_keke_rating();

-- Existing riders have reviews that predate the trigger: recompute once.
UPDATE public.kekes k
SET rating = s.avg_rating,
    rating_count = s.review_count
FROM (
  SELECT r.keke_id,
         ROUND(AVG(rv.rating)::numeric, 1) AS avg_rating,
         COUNT(*)::integer AS review_count
  FROM public.reviews rv
  JOIN public.rides r ON r.id = rv.ride_id
  WHERE r.keke_id IS NOT NULL
  GROUP BY r.keke_id
) s
WHERE k.id = s.keke_id;
