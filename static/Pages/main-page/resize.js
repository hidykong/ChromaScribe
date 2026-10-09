const resizer = document.getElementById('resizer');
const leftDiv = document.getElementById('div1');
const rightDiv = document.getElementById('div2');
const container = document.querySelector('.flex-container container');

let startX;
let startWidthLeft;
let startWidthRight;

resizer.addEventListener('mousedown', (e) => {
    startX = e.clientX;
    startWidthLeft = leftDiv.getBoundingClientRect().width;
    startWidthRight = rightDiv.getBoundingClientRect().width;
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
});

function onMouseMove(e) {
    const dx = e.clientX - startX;
    leftDiv.style.width = `${startWidthLeft + dx}px`;
    rightDiv.style.width = `${startWidthRight - dx}px`;
}

function onMouseUp() {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
}
