-- Migration: add 'unavailable' as a fourth keke_status value.
--
-- Why a 4th enum value (not a new column or table):
--   dispatch_next_ride_request() already selects only status = 'online',
--   so an 'unavailable' rider is automatically excluded from dispatch.
--   No dispatch changes are required, and no schema is duplicated.
--
-- Why it must be its own file:
--   PostgreSQL cannot use a newly added enum value in the same transaction
--   that added it. `supabase db push` applies each migration file in its own
--   transaction, so this file contains ONLY the ALTER TYPE statement.
--
-- Safety:
--   Additive and idempotent (IF NOT EXISTS). No existing rows are modified;
--   the default ('offline') and existing values are unchanged.

ALTER TYPE public.keke_status ADD VALUE IF NOT EXISTS 'unavailable';
