// часы записи в отдельном потоке: таймеры вкладки, которая не на виду, браузер притормаживает, а потока — нет
let timer = 0;
onmessage = (e) => {
  clearInterval(timer);
  if (e.data > 0) timer = setInterval(() => postMessage(0), e.data);
};
