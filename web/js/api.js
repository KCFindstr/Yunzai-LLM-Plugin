/** JSON API client. A 401 sends the app back to the login screen. */

let onUnauthorized = () => {}
export const setUnauthorizedHandler = fn => { onUnauthorized = fn }

export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'x-requested-with': 'yzllm', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  })
  let data
  try { data = await res.json() } catch { data = undefined }
  if (res.status === 401 && path !== '/api/login') {
    onUnauthorized()
    throw new Error('登录已失效')
  }
  if (!res.ok) throw Object.assign(new Error(data?.error || `请求失败（${res.status}）`), { status: res.status })
  return data
}

export const get = p => api('GET', p)
export const post = (p, b = {}) => api('POST', p, b)
export const put = (p, b = {}) => api('PUT', p, b)
export const del = p => api('DELETE', p)
export const enc = encodeURIComponent
