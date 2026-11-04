import { animate } from 'motion'

document.getElementById('button').addEventListener('click', () => {
  document.getElementById('css').classList.add('on')
  animate('#motion', { x: 300 }, { duration: 1, ease: [0.3, 0, 0.2, 1] })
  animate('#fade', { opacity: [0, 1] }, { duration: 1, ease: 'linear' })
})
