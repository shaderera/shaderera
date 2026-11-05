import { animate } from 'motion'

animate('#a', { x: 400 }, { type: 'spring', stiffness: 200, damping: 10 })
animate('#b', { opacity: [0, 1] }, { duration: 1, ease: 'linear' })
animate('#c', { x: [0, 300], rotate: [0, 90] }, { type: 'spring', bounce: 0.5, duration: 0.8 })
