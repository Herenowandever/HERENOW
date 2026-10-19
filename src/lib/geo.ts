export interface Fix {
  lat: number
  lng: number
  accuracy: number
}

export function getFix(): Promise<Fix> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('NO_GEO'))
      return
    }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) => reject(new Error(e.code === e.PERMISSION_DENIED ? 'GEO_DENIED' : 'GEO_FAILED')),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
    )
  })
}

export function distanceM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const r = (x: number) => (x * Math.PI) / 180
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lng2 - lng1) / 2) ** 2
  return 2 * 6371008.8 * Math.asin(Math.sqrt(a))
}
