// the recording clock in a separate thread: the browser throttles the timers of a tab that is out of sight, but not a worker's
let timer = 0;
onmessage = (e) => {
  clearInterval(timer);
  if (e.data > 0) timer = setInterval(() => postMessage(0), e.data);
};
