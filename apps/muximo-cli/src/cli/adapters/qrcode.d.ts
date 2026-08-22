declare module "qrcode" {
  type ErrorCorrectionLevel = "L" | "M" | "Q" | "H";
  type OutputType = "terminal" | "svg";

  export function toString(
    text: string,
    options?: {
      type?: OutputType;
      small?: boolean;
      errorCorrectionLevel?: ErrorCorrectionLevel;
      margin?: number;
    },
  ): Promise<string>;
}
