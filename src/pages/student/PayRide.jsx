import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import Layout from '../../components/Layout.jsx'
import { supabase } from '../../lib/supabase'

function loadPaystack() {
  if (window.PaystackPop) return Promise.resolve()

  return new Promise((resolve, reject) => {
    let script = document.querySelector('[data-paystack-inline]')

    if (!script) {
      script = document.createElement('script')
      script.src = 'https://js.paystack.co/v2/inline.js'
      script.dataset.paystackInline = 'true'
      document.head.appendChild(script)
    }

    script.addEventListener('load', resolve, { once: true })
    script.addEventListener(
      'error',
      () => reject(new Error('Could not load Paystack. Check your network and try again.')),
      { once: true },
    )

    if (window.PaystackPop) resolve()
  })
}

export default function PayRide({ rideId, onBack }) {
  const [ride, setRide] = useState(null)
  const [ticket, setTicket] = useState(null)
  const [loading, setLoading] = useState(true)
  const [paying, setPaying] = useState(false)
  const [checking, setChecking] = useState(false)
  const [watching, setWatching] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true

    async function loadRide() {
      setLoading(true)
      setError('')

      const { data, error: rideError } = await supabase
        .from('rides')
        .select('id, fare, status')
        .eq('id', rideId)
        .maybeSingle()

      if (!active) return

      if (rideError || !data) {
        setError('Could not load this booking. Please return to your ride screen and try again.')
      } else {
        setRide(data)
      }

      setLoading(false)
    }

    if (rideId) loadRide()
    else {
      setError('A ride ID is required to make payment.')
      setLoading(false)
    }

    return () => {
      active = false
    }
  }, [rideId])

  const checkPayment = useCallback(async () => {
    if (!rideId || checking) return false

    setChecking(true)

    try {
      const { data, error: rideError } = await supabase
        .from('rides')
        .select('id, fare, status')
        .eq('id', rideId)
        .maybeSingle()

      if (rideError || !data) {
        setMessage('We could not confirm the status yet. Check your connection and try again.')
        return false
      }

      setRide(data)

      if (data.status === 'refunded') {
        setMessage('This ride has been refunded. Contact support if you need help.')
        return true
      }

      if (['paid', 'arrived', 'on_trip', 'completed'].includes(data.status)) {
        const { data: ticketData, error: ticketError } = await supabase
          .from('tickets')
          .select('ticket_no, status')
          .eq('ride_id', rideId)
          .maybeSingle()

        if (ticketError) {
          setMessage('Payment was recorded. Your ticket is being checked; please try again shortly.')
          return false
        }

        if (ticketData) {
          setTicket(ticketData)
          setMessage('')
          setWatching(false)
          return true
        }

        setMessage('Payment was recorded, but the ticket is not ready yet. Keep this page open and check again.')
        return false
      }

      setMessage('Payment is not confirmed yet. If you completed checkout, please wait and check again.')
      return false
    } finally {
      setChecking(false)
    }
  }, [rideId, checking])

  useEffect(() => {
    if (!watching) return

    let attempts = 0

    const timer = window.setInterval(async () => {
      attempts += 1
      const finished = await checkPayment()

      if (finished || attempts >= 40) {
        window.clearInterval(timer)
        setWatching(false)

        if (!finished) {
          setMessage(
            'Confirmation is taking longer than expected. Do not pay again yet. Check your payment status or contact support.',
          )
        }
      }
    }, 3000)

    return () => window.clearInterval(timer)
  }, [watching, checkPayment])

  async function payNow() {
    if (!rideId || paying || ride?.status !== 'accepted') return

    setPaying(true)
    setError('')
    setMessage('Connecting securely to Paystack…')

    try {
      const { data, error: invokeError } = await supabase.functions.invoke(
        'start-payment',
        { body: { ride_id: rideId } },
      )

      if (invokeError) {
        let detail = invokeError.message

        if (invokeError.context?.json) {
          try {
            const payload = await invokeError.context.json()
            detail = payload?.error || detail
          } catch {}
        }

        throw new Error(detail || 'Could not start payment.')
      }

      if (data?.error) throw new Error(data.error)

      if (!data?.access_code || !data?.reference) {
        throw new Error('Paystack did not return a valid checkout session.')
      }

      await loadPaystack()

      if (!window.PaystackPop) {
        throw new Error('Paystack could not be opened. Please try again.')
      }

      // Checkout is initialized on our server. Never expose the secret key here.
      const popup = new window.PaystackPop()
      popup.resumeTransaction(data.access_code)

      setMessage('Complete payment in the Paystack window. Keep this page open.')
      setWatching(true)
    } catch (paymentError) {
      setError(paymentError?.message || 'Payment could not be started.')
      setMessage('')
    } finally {
      setPaying(false)
    }
  }

  const fare = Number(ride?.fare)

  return (
    <Layout title="Ride payment">
      <section style={{ paddingTop: 12 }}>
        <Link to="/student">← Back to home</Link>

        <h2 style={{ marginTop: 20 }}>Pay for your ride</h2>
        <p className="muted">
          Your fare is fixed. Complete payment after your Keke has accepted
          your request.
        </p>

        {loading && <div className="card">Loading your booking…</div>}

        {!loading && error && (
          <div className="error" role="alert">{error}</div>
        )}

        {!loading && ride && !ticket && (
          <div className="card">
            <p className="muted">Booking reference</p>
            <p><strong>{ride.id}</strong></p>

            <div className="fare">
              <span>Ride fare</span>
              <h2>₦{Number.isFinite(fare) ? fare.toLocaleString('en-NG') : '—'}</h2>
              <span className="badge">
                {ride.status.replaceAll('_', ' ')}
              </span>
            </div>

            {ride.status === 'accepted' && (
              <button
                className="btn"
                type="button"
                disabled={paying}
                onClick={payNow}
              >
                {paying ? 'Connecting…' : 'Pay with Paystack'}
              </button>
            )}

            {['searching'].includes(ride.status) && (
              <p className="muted">Your Keke has not accepted the ride yet.</p>
            )}

            {['paid', 'arrived', 'on_trip', 'completed'].includes(ride.status) && (
              <p className="ok">Payment has been recorded. Checking your ticket…</p>
            )}

            {['cancelled', 'refunded'].includes(ride.status) && (
              <p className="error">
                This booking cannot be paid for in its current state.
              </p>
            )}

            {message && (
              <div className="ok" role="status" style={{ marginTop: 12 }}>
                {message}
              </div>
            )}

            <button
              className="btn"
              type="button"
              disabled={checking}
              onClick={checkPayment}
              style={{ marginTop: 12 }}
            >
              {checking ? 'Checking…' : 'Check payment status'}
            </button>

            {onBack && (
              <button
                type="button"
                className="opt"
                onClick={onBack}
                style={{ marginTop: 8 }}
              >
                Return to booking
              </button>
            )}
          </div>
        )}

        {!loading && ticket && (
          <div className="slip" role="status">
            <h2>Payment confirmed</h2>
            <p>Your payment has been recorded by Danfolio.</p>
            <p className="muted">Your ticket number</p>
            <h2>{ticket.ticket_no}</h2>
            <span className="badge">{ticket.status}</span>
            <p>Keep this ticket as proof of payment for your ride.</p>
            <Link to={`/student/ticket/${rideId}`}>
              Open ticket
            </Link>
          </div>
        )}
      </section>
    </Layout>
  )
}
