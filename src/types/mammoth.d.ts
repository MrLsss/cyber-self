declare module 'mammoth' {
  export interface MammothImage {
    contentType: string
    altText?: string
    read(): Promise<Buffer>
    read(format: 'base64'): Promise<string>
  }

  export interface MammothImageResult {
    src: string
    alt?: string
  }

  export interface MammothImages {
    imgElement(handler: (image: MammothImage) => Promise<MammothImageResult>): unknown
  }

  export interface MammothInput {
    buffer: Buffer
  }

  export interface MammothOptions {
    convertImage?: unknown
    styleMap?: string[]
    includeDefaultStyleMap?: boolean
  }

  export interface MammothMessage {
    type: string
    message: string
  }

  export interface MammothResult {
    value: string
    messages: MammothMessage[]
  }

  export const images: MammothImages

  export function convertToMarkdown(input: MammothInput, options?: MammothOptions): Promise<MammothResult>

  export function convertToHtml(input: MammothInput, options?: MammothOptions): Promise<MammothResult>
}
