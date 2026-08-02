export interface FleetWorkerOutputDto {
  runId: string;
  workerId: string;
  attempt: number;
  sessionId: string;
  lines: number;
  output: string;
  truncated: boolean;
  capturedAt: string;
}
