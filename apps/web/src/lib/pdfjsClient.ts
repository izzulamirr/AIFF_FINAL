// pdf.js for the browser, loaded once and shared: the P&ID comparison and the
// report's marked-up ISO both draw PDFs client-side. Import only from a
// "use client" component -- it starts a Web Worker.

export type PdfLib = typeof import("pdfjs-dist");
export type PdfDoc = Awaited<ReturnType<PdfLib["getDocument"]>["promise"]>;

let pdfjs: Promise<PdfLib> | null = null;

export function loadPdfjs(): Promise<PdfLib> {
  if (!pdfjs) {
    pdfjs = import("pdfjs-dist").then((lib) => {
      lib.GlobalWorkerOptions.workerPort = new Worker(new URL("pdfjs-dist/build/pdf.worker.min.js", import.meta.url));
      return lib;
    });
  }
  return pdfjs;
}
