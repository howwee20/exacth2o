import { NextResponse } from 'next/server'
import { requireUiSession } from '@/app/lib/server-auth'

const API_BASE_URL = process.env.API_URL || 'http://api_svc:8888/v1'

export const runtime = 'nodejs'

export async function GET() {
  try {
    await requireUiSession()
    const upstreamUrl = `${API_BASE_URL}/sensors/export-stream`
    const upstreamResponse = await fetch(upstreamUrl, {
      method: 'GET',
      cache: 'no-store'
    })

    if (!upstreamResponse.ok || !upstreamResponse.body) {
      const errorText = await upstreamResponse.text().catch(() => 'Failed to export sensors')
      return NextResponse.json(
        { message: errorText || 'Failed to export sensors' },
        { status: upstreamResponse.status || 500 }
      )
    }

    const responseHeaders = new Headers()
    responseHeaders.set('Content-Type', upstreamResponse.headers.get('content-type') || 'application/gzip')
    responseHeaders.set(
      'Content-Disposition',
      upstreamResponse.headers.get('content-disposition') || 'attachment; filename="sensors.csv.gz"'
    )
    responseHeaders.set('Cache-Control', 'no-store')

    return new NextResponse(upstreamResponse.body, {
      status: 200,
      headers: responseHeaders
    })
  } catch (error) {
    console.error('Error proxying sensors export:', error)
    return NextResponse.json({ message: 'Failed to export sensors' }, { status: 500 })
  }
}
