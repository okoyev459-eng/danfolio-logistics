-- Location categories — students pick a spot from a grouped list
-- (Academic block / Hostel / Cafeteria / …) instead of one flat list.
--
-- category is a plain admin-managed label: the admin Locations screen edits it
-- directly, and the student booking sheet groups by it. Nothing derives it
-- automatically at runtime, so renaming a category never breaks a booking.

ALTER TABLE public.locations ADD COLUMN IF NOT EXISTS category text;

-- Backfill the existing 15 points from their own names so the grouped picker
-- is useful immediately. Every row here is a real, admin-created location;
-- the mapping only labels what the name already says.
UPDATE public.locations
SET category = CASE
  WHEN name IN ('Faculty of Science', 'NLT', 'Library Gate', 'Auditorium')
    THEN 'Academic block'
  WHEN name IN ('Hostel A', 'Hostel B', 'Hostel Row')
    THEN 'Hostel'
  WHEN name = 'Cafeteria'
    THEN 'Cafeteria'
  WHEN name = 'Main Gate'
    THEN 'Main gate'
  WHEN name IN ('Chapel Junction', 'Front of MPH')
    THEN 'Stations'
  WHEN name = 'Market Road'
    THEN 'Landmark'
  ELSE 'Other'
END
WHERE category IS NULL OR btrim(category) = '';

-- New points added without a category land in a visible group rather than
-- disappearing from the grouped list.
ALTER TABLE public.locations ALTER COLUMN category SET DEFAULT 'Other';
ALTER TABLE public.locations ALTER COLUMN category SET NOT NULL;

COMMENT ON COLUMN public.locations.category IS
  'Grouping label shown to students in the booking picker (e.g. Academic block, Hostel, Cafeteria). Admin-editable.';
