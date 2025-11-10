export async function postJSON<T>(path: string, body: unknown): Promise<T> {
    const base = process.env.BACKEND_URL!;
    const key = process.env.BACKEND_API_KEY!;
    const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-api-key': key
        },
        body: JSON.stringify(body)
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Backend ${res.status}: ${text || res.statusText}`);
    }
    return res.json() as Promise<T>;
}
