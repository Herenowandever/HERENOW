// Turns database and device error codes into sentences people can act on.

export interface Friendly {
  text: string
  suggestQr?: boolean
}

export function friendly(err: unknown): Friendly {
  const raw = err instanceof Error ? err.message : typeof err === 'object' && err && 'message' in err ? String((err as { message: unknown }).message) : String(err)
  const [code, ...parts] = raw.split('|')

  switch (code.trim()) {
    case 'OUTSIDE_ZONE':
      return { text: `You're ${parts[0]} m from ${parts[2]}. Move within ${parts[1]} m and try again, or scan the office QR code.`, suggestQr: true }
    case 'WEAK_GPS':
      return { text: `Your location is only accurate to about ${parts[0]} m right now. Step near a window and try again, or scan the office QR code.`, suggestQr: true }
    case 'GEO_DENIED':
      return { text: 'HereNow needs your location to clock you in. Allow location for this site in your browser settings, or scan the office QR code.', suggestQr: true }
    case 'GEO_FAILED':
    case 'NO_GEO':
    case 'NO_LOCATION':
      return { text: "Your phone couldn't find your location. Try again outdoors or near a window, or scan the office QR code.", suggestQr: true }
    case 'INVALID_QR':
      return { text: "That isn't today's office code. Scan the QR screen at reception again." }
    case 'NO_OFFICE':
      return { text: 'Your company has not set up an office location yet. Ask your admin to add one.' }
    case 'NEEDS_SELFIE':
      return { text: 'Take a selfie first, then clock in.' }
    case 'NEEDS_CONSENT':
      return { text: 'Please read and accept the privacy notice first.' }
    case 'ALREADY_IN':
      return { text: "You're already clocked in." }
    case 'ALREADY_DONE':
      return { text: "You've already completed a shift today. Ask your admin if this needs correcting." }
    case 'NOT_IN':
      return { text: "You're not clocked in, so there's nothing to clock out of." }
    case 'NOT_A_MEMBER':
      return { text: 'Your account is not active in a company. Ask your admin for help.' }
    case 'BAD_JOIN_CODE':
      return { text: "That company code wasn't found. Check it with your admin; it's 8 letters and numbers." }
    case 'ALREADY_IN_COMPANY':
      return { text: 'This account already belongs to a company.' }
    case 'ADMIN_ONLY':
      return { text: 'Only company admins can do that.' }
    case 'CANNOT_DEMOTE_SELF':
      return { text: "You can't remove your own admin access. Ask another admin to do it." }
    case 'BAD_TIMES':
      return { text: 'Clock-out must be after clock-in.' }
    case 'CAMERA_DENIED':
      return { text: 'HereNow needs the camera for your check-in selfie. Allow camera access in your browser settings.' }
    case 'Invalid login credentials':
      return { text: 'That email and password do not match. Check them and try again.' }
    default:
      return { text: raw || 'Something went wrong. Check your connection and try again.' }
  }
}
