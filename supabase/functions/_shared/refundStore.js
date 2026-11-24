// The database side of the refund flow, in one adapter.
//
// refundFlow.js only talks to this interface, so the same orchestration code
// runs against Supabase in production and against an in-memory store in the
// hermetic tests. Every write is guarded (status / refund_status predicates)
// so two concurrent callers can never both act on the same refund.

export function createRefundStore(db) {
  return {
    async getRide(rideId) {
      const { data, error } = await db
        .from('rides')
        .select('id, keke_id, status, interrupted_at')
        .eq('id', rideId)
        .maybeSingle()
      if (error) throw error
      return data
    },

    async getPayment(rideId) {
      const { data, error } = await db
        .from('payments')
        .select(
          'id, ride_id, paystack_ref, amount, status, method, ' +
          'refund_status, refund_reference, refund_requested_at, refunded_at, ' +
          'refund_needs_attention',
        )
        .eq('ride_id', rideId)
        .maybeSingle()
      if (error) throw error
      return data
    },

    async findPayment({ reference, refundReference }) {
      let query = db
        .from('payments')
        .select(
          'id, ride_id, paystack_ref, amount, status, method, refund_status, ' +
          'refund_reference, refunded_at, refund_needs_attention',
        )

      query = reference
        ? query.eq('paystack_ref', reference)
        : query.eq('refund_reference', refundReference)

      const { data, error } = await query.maybeSingle()
      if (error) throw error
      return data
    },

    // Conditional claim: succeeds only for a successful payment with no
    // refund yet, or a DEFINITELY rejected attempt with no provider refund id.
    async claimRefund(paymentId, { reason, actorId, now }) {
      const { data, error } = await db
        .from('payments')
        .update({
          refund_status: 'pending',
          refund_requested_at: now,
          refund_reason: reason,
          refunded_by: actorId,
          refund_last_error: null,
          refund_needs_attention: false,
        })
        .eq('id', paymentId)
        .eq('status', 'success')
        .or('refund_status.is.null,and(refund_status.eq.failed,refund_reference.is.null)')
        .select('id')
        .maybeSingle()

      if (error) throw error
      return Boolean(data)
    },

    async markRefundAccepted(paymentId, { reference, refundStatus, processed, now }) {
      const patch = {
        refund_status: refundStatus,
        refund_reference: reference,
        refund_last_error: null,
        refund_needs_attention: false,
      }
      if (processed) {
        patch.status = 'refunded'
        patch.refunded_at = now
      }

      const { error } = await db
        .from('payments')
        .update(patch)
        .eq('id', paymentId)
      if (error) throw error
    },

    async markRefundFailed(paymentId, { refundStatus, error, needsAttention }) {
      const { error: updateError } = await db
        .from('payments')
        .update({
          refund_status: refundStatus,
          refund_last_error: error,
          refund_needs_attention: needsAttention,
        })
        .eq('id', paymentId)

      if (updateError) throw updateError
    },

    async updatePayment(paymentId, patch) {
      const { error } = await db
        .from('payments')
        .update(patch)
        .eq('id', paymentId)
      if (error) throw error
    },

    // Guarded status move: returns false when another writer got there first.
    async setRideStatus(rideId, status, fromStatuses) {
      const { data, error } = await db
        .from('rides')
        .update({ status })
        .eq('id', rideId)
        .in('status', fromStatuses)
        .select('id')
        .maybeSingle()

      if (error) throw error
      return Boolean(data)
    },

    async releaseKeke(kekeId) {
      const { error } = await db.rpc('release_keke_if_idle', {
        p_keke_id: kekeId,
      })
      if (error) throw error
      return true
    },

    async recordEvent({
      rideId,
      event,
      reason,
      actorId,
      actorRole,
      fromStatus,
      toStatus,
      metadata,
    }) {
      const { error } = await db.from('ride_events').insert({
        ride_id: rideId,
        actor_id: actorId ?? null,
        actor_role: actorRole ?? 'system',
        event,
        reason: reason ?? null,
        from_status: fromStatus ?? null,
        to_status: toStatus ?? null,
        metadata: metadata ?? {},
      })

      // The audit trail must never turn a recorded refund into a failure.
      if (error) console.error('refund store: could not record event:', error)
      return !error
    },
  }
}
