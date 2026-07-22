import { NextRequest, NextResponse } from 'next/server'
import { requireUiSession } from '@/app/lib/server-auth'

const API_BASE_URL = process.env.API_URL || 'http://api_svc:8888/v1'

export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  try {
    await requireUiSession()
    const { searchParams } = request.nextUrl
    const sensorIds = searchParams.get('sensorIds')
    const startDate = searchParams.get('startDate')
    const endDate = searchParams.get('endDate')

    if (!sensorIds || !startDate || !endDate) {
      return NextResponse.json(
        { message: 'sensorIds, startDate, and endDate are required query params' },
        { status: 400 }
      )
    }

    const upstreamUrl = `${API_BASE_URL}/readings/export-stream?${searchParams.toString()}`
    const upstreamResponse = await fetch(upstreamUrl, {
      method: 'GET',
      cache: 'no-store'
    })

    if (!upstreamResponse.ok || !upstreamResponse.body) {
      const errorText = await upstreamResponse.text().catch(() => 'Failed to export readings')
      return NextResponse.json(
        { message: errorText || 'Failed to export readings' },
        { status: upstreamResponse.status || 500 }
      )
    }

    const responseHeaders = new Headers()
    responseHeaders.set('Content-Type', upstreamResponse.headers.get('content-type') || 'application/gzip')
    responseHeaders.set(
      'Content-Disposition',
      upstreamResponse.headers.get('content-disposition') || 'attachment; filename="sensor-readings.csv.gz"'
    )
    responseHeaders.set('Cache-Control', 'no-store')

    return new NextResponse(upstreamResponse.body, {
      status: 200,
      headers: responseHeaders
    })
  } catch (error) {
    console.error('Error proxying readings export:', error)
    return NextResponse.json({ message: 'Failed to export readings' }, { status: 500 })
  }
}
