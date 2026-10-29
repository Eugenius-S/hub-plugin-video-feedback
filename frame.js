// a screen shot is scaled and encoded in a separate thread: the page only hands over the bitmap and receives the JPEG
onmessage = async (e) => {
  const { id, bitmap, w, h, quality } = e.data;
  try {
    const c = new OffscreenCanvas(w, h);
    c.getContext("2d").drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    postMessage({ id, blob: await c.convertToBlob({ type: "image/jpeg", quality }) });
  } catch { postMessage({ id, blob: null }); }
};
