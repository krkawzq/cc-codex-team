export type Ok<T> = { ok: true; data: T };
export type Err = { ok: false; error: { code: string; message: string; data?: unknown } };
export type Result<T> = Ok<T> | Err;

export function ok<T>(data: T): Ok<T> {
  return { ok: true, data };
}

export function err(code: string, message: string, data?: unknown): Err {
  const error: Err["error"] = { code, message };
  if (data !== undefined) {
    error.data = data;
  }
  return { ok: false, error };
}
