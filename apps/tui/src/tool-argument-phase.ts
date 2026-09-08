/** Display the shared Main/Child argument lifecycle without inferring tool admission. */
export function toolArgumentPhaseLabel(status: string): string | undefined {
  switch (status) {
    case "generating_arguments":
      return "Generating arguments";
    case "awaiting_model_completion":
      return "Arguments received · waiting for model completion";
    case "processing_response":
      return "Processing model response";
    default:
      return undefined;
  }
}
