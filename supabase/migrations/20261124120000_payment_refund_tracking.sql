-- =====================================================================
-- Refund tracking on payments.
--
-- The old refund flow marked payments.status = 'refunded' the moment
-- Paystack ACCEPTED the refund request, so a later refund.failed (or an
-- accepted-then-reversed refund) still looked settled in the database.
-- These columns separate "the refund was requested" from "the money came
-- back", which is what the webhook and the admin view need:
--
--   refund_status          pending | processed | failed   (NULL = none yet)
--   refund_reference       Paystack's refund id (`data.id` in the response)
--   refund_requested_at    when the provider request was accepted/claimed
--   refunded_at            when Paystack confirmed the refund PROCESSED
--   refund_reason          why the refund was made (also copied to ride_events)
--   refunded_by            the student/rider/admin who triggered it
--   refund_last_error      last provider/network error, for admin review
--   refund_needs_attention true when a human must reconcile with Paystack
--
-- payments.status = 'refunded' now means refund_status = 'processed'
-- (Paystack confirmed), never merely "request accepted".
-- =====================================================================

alter table public.payments
  add column if not exists refund_reference      text,
  add column if not exists refund_status         text,
  add column if not exists refund_requested_at   timestamptz,
  add column if not exists refunded_at           timestamptz,
  add column if not exists refund_reason         text,
  add column if not exists refunded_by           uuid
    references public.profiles (id) on delete set null,
  add column if not exists refund_last_error     text,
  add column if not exists refund_needs_attention boolean not null default false;

alter table public.payments
  drop constraint if exists payments_refund_status_check;

alter table public.payments
  add constraint payments_refund_status_check
  check (refund_status is null or refund_status in ('pending', 'processed', 'failed'));

-- One provider refund id can only ever belong to one payment: this makes a
-- duplicated refund response (or a replayed webhook) impossible to record
-- against two rows.
create unique index if not exists payments_refund_reference_key
  on public.payments (refund_reference)
  where refund_reference is not null;

create index if not exists payments_refund_attention_idx
  on public.payments (refund_requested_at desc)
  where refund_needs_attention;

comment on column public.payments.refund_status is
  'pending = Paystack accepted the request but has not confirmed the money moved; processed = confirmed refunded (payments.status is also refunded); failed = the refund did not complete and MUST be reviewed. NULL = no refund attempted.';
comment on column public.payments.refund_reference is
  'Paystack refund id from the provider response (data.id). Unique when present.';
comment on column public.payments.refunded_at is
  'When Paystack CONFIRMED the refund processed (refund.processed webhook or an immediately-processed response). Never set merely because the request was accepted.';
comment on column public.payments.refund_reason is
  'Why the refund was requested; also recorded on ride_events.';
comment on column public.payments.refunded_by is
  'The student, rider or admin who triggered the refund (service functions pass the actor id).';
comment on column public.payments.refund_needs_attention is
  'True when a refund outcome is unknown/failed and a human must reconcile it with Paystack before retrying.';

-- Legacy rows: the old code set payments.status = 'refunded' on provider
-- ACCEPTANCE and stored no refund id, so their true provider state was never
-- verified. Keep the app's historical view (processed) but flag them so an
-- admin can confirm in the Paystack dashboard.
--
-- refunded_at comes from the refund-ride audit event (the moment the old
-- function recorded payment_refunded), NOT from the migration clock: the
-- timestamp must describe the refund, not the deploy. now() is only a
-- fallback for a refunded row that has no such event at all.
update public.payments p
set refund_status = 'processed',
    refunded_at = coalesce(
      (
        select min(e.created_at)
        from public.ride_events e
        where e.ride_id = p.ride_id
          and e.event = 'payment_refunded'
      ),
      now()
    ),
    refund_reason = coalesce(refund_reason, 'legacy_backfill'),
    refund_needs_attention = true
where p.status = 'refunded'
  and p.refund_status is null;
