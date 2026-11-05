import gsap from 'gsap'

gsap.to('#a', { x: 400, duration: 1, ease: 'power3.out', delay: 0.2 })
gsap.to('#b', { x: 400, duration: 1.5, ease: 'elastic.out(1, 0.3)' })
gsap.to('#lin', { x: 600, duration: 2, ease: 'none' })
