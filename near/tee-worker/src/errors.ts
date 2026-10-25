export class WorkerError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "WorkerError";
    this.code = code;
    this.status = status;
  }
}

export function asWorkerError(error: unknown): WorkerError {
  if (error instanceof WorkerError) return error;
  if (error instanceof Error) return new WorkerError("INVALID_REQUEST", error.message, 400);
  return new WorkerError("INTERNAL_ERROR", "Unexpected worker failure", 500);
}

